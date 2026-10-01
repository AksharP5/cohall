import {
  Device,
  SocketEvent,
  decodeSocketEvent,
  maxSocketPayloadBytes,
  now,
  taskSlot,
  version,
  type Bot,
  type Provider,
  type DeviceOperation,
  type InputAttachment,
  type OperationId,
  type Task,
  type TaskId,
  type TaskRunId,
  type RequestTaskInput,
} from "@cohall/protocol"
import * as Providers from "@cohall/providers"
import { Effect, Schedule, Schema } from "effect"
import { constants } from "node:fs"
import { open, realpath, stat } from "node:fs/promises"
import { arch, hostname, platform } from "node:os"
import { basename, isAbsolute, relative } from "node:path"
import { WebSocket, type RawData } from "ws"
import type { DeviceConfiguration } from "./config.ts"
import { discoverGrokBots, runGrokBot } from "./grok-bot.ts"
import { cleanupBotReply } from "./bot-replies.ts"
import { upgrade, type UpgradeOptions, type UpgradeResult } from "./upgrade.ts"
import { prepareTaskFiles, type TaskFiles } from "./task-attachments.ts"

const maxQueuedRelayMessages = 8

type TaskTerminalEvent = Extract<
  SocketEvent,
  { readonly _tag: "TaskFinished" | "TaskFailed" | "TaskCancelled" | "TaskInputRequested" }
>

export class DeviceConnectionError extends Schema.TaggedErrorClass<DeviceConnectionError>()(
  "Device.ConnectionError",
  { message: Schema.String },
) {}

interface State {
  socket: WebSocket | undefined
  stopping: boolean
  supportsAttachments: boolean
  supportsClarification: boolean
  processing: Promise<void>
  readonly terminal: Map<string, TaskTerminalEvent>
  readonly queue: Array<Task>
  readonly sessions: Map<string, string>
  readonly tasks: Map<
    TaskId,
    { readonly task: Task; readonly controller: AbortController; readonly done: Promise<void> }
  >
  readonly completed: Set<string>
  operation: DeviceOperation | undefined
  readonly operationQueue: Array<DeviceOperation>
  readonly operationTerminal: Map<OperationId, string>
  readonly completedOperations: Set<OperationId>
}

const socketUrl = (configuration: DeviceConfiguration): string => {
  const url = new URL(configuration.relayUrl)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.pathname = "/ws/device"
  return url.toString()
}

const providerLabel = (provider: Provider): string => {
  switch (provider) {
    case "codex":
      return "Codex"
    case "claude-code":
      return "Claude Code"
    case "opencode":
      return "OpenCode"
    case "grok-bot":
      return "Grok Bot"
  }
}

const capabilities = (providers: ReadonlyArray<Provider>): Device["capabilities"] => {
  const values: Array<Device["capabilities"][number]> = providers.map((provider) => ({
    id: provider,
    label: providerLabel(provider),
    detail:
      provider === "grok-bot"
        ? "Named bots through this computer's local Grok Bot gateway"
        : `${providerLabel(provider)} executable detected; authentication is checked when work starts`,
  }))
  if (providers.some((provider) => provider !== "grok-bot")) {
    values.push({ id: "task-attachments", label: "Task file attachments" })
  }
  values.push({ id: "task-clarification", label: "Task clarification and resume" })
  values.push({ id: "task-deadlines", label: "Task deadlines" })
  if (
    Providers.findExecutable("google-chrome") !== undefined ||
    Providers.findExecutable("chromium") !== undefined ||
    platform() === "darwin"
  ) {
    values.push({ id: "browser-session", label: "Signed-in browser" })
  }
  if (Providers.findExecutable("xcodebuild") !== undefined) {
    values.push({ id: "xcode", label: "Xcode" })
  }
  if (Providers.findExecutable("docker") !== undefined) {
    values.push({ id: "docker", label: "Docker" })
  }
  return values
}

export const selectProviders = (
  installed: ReadonlyArray<Provider>,
  configured?: ReadonlyArray<Provider>,
): ReadonlyArray<Provider> =>
  configured === undefined
    ? installed
    : configured.filter((provider) => installed.includes(provider))

const describeDevice = (
  configuration: DeviceConfiguration,
  status: "online" | "busy" = "online",
  bots: ReadonlyArray<Bot> = [],
): Device => {
  const operatingSystem = platform()
  const platformName =
    operatingSystem === "darwin" || operatingSystem === "linux"
      ? operatingSystem
      : operatingSystem === "win32"
        ? "windows"
        : "unknown"
  const installed: ReadonlyArray<Provider> = [
    ...Providers.availableProviders(),
    ...(configuration.grokGateway === undefined ? [] : ["grok-bot" as const]),
  ]
  const providers = selectProviders(installed, configuration.providers)
  return Device.make({
    id: configuration.id,
    name: configuration.name,
    hostname: hostname(),
    platform: platformName,
    architecture: arch(),
    status,
    providers,
    ...(providers.includes("grok-bot") ? { bots } : {}),
    capabilities: capabilities(providers),
    workspaces: configuration.workspaces.map((path) => ({
      path,
      label: basename(path) || path,
    })),
    version,
    lastSeenAt: now(),
  })
}

export const allowedWorkspace = async (
  configuration: DeviceConfiguration,
  requested: string | undefined,
): Promise<string> => {
  const selected = requested ?? configuration.workspaces[0]
  if (selected === undefined) {
    throw new Error("No workspace is configured on this device")
  }
  const candidate = await realpath(selected)
  const allowed = configuration.workspaces.some((root) => {
    const child = relative(root, candidate)
    return child === "" || (!child.startsWith("..") && !isAbsolute(child))
  })
  if (!allowed) {
    throw new Error(`Workspace ${candidate} is outside this device's configured workspace roots`)
  }
  return candidate
}

interface AuthorizedWorkspace {
  readonly cwd: string
  readonly validate: () => Promise<void>
  readonly close: () => Promise<void>
}

export const openAllowedWorkspace = async (
  configuration: DeviceConfiguration,
  requested: string | undefined,
): Promise<AuthorizedWorkspace> => {
  const path = await allowedWorkspace(configuration, requested)
  const operatingSystem = platform()
  const flags =
    constants.O_RDONLY |
    (operatingSystem === "win32" ? 0 : constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const handle = await open(path, flags)
  const identity = await handle.stat()
  if (!identity.isDirectory()) {
    await handle.close()
    throw new Error(`Workspace ${path} is not a directory`)
  }
  // macOS resolves cwd after closing non-inherited descriptors during posix_spawn,
  // so /dev/fd cannot safely serve as a directory cwd there.
  const cwd = operatingSystem === "linux" ? `/proc/self/fd/${handle.fd}` : path
  return {
    cwd,
    validate: async () => {
      const current = await handle.stat()
      if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) {
        throw new Error(`Workspace ${path} changed before provider startup`)
      }
      if (operatingSystem !== "linux") {
        const currentPath = await realpath(path)
        const currentPathIdentity = await stat(currentPath)
        if (currentPathIdentity.dev !== identity.dev || currentPathIdentity.ino !== identity.ino) {
          throw new Error(`Workspace ${path} changed before provider startup`)
        }
      }
    },
    close: () => handle.close(),
  }
}

const promptFor = (
  task: Task,
  deviceName: string,
  supportsClarification: boolean,
  files?: TaskFiles,
): string => {
  const context =
    task.context === undefined
      ? ""
      : `\n\nRelevant context supplied by the sending agent:\n${task.context}`
  return [
    `You are the Cohall agent running on ${deviceName}.`,
    "Complete the delegated task using this device's local workspace, tools, credentials, and signed-in services.",
    "Never read, reveal, copy, or use Cohall configuration files or Cohall authentication tokens.",
    "Return a concise, complete result with the evidence the sending agent needs.",
    "For long tasks, optionally report a brief milestone with `cohall progress --message 'Running tests'`. Do not include logs or secrets in progress notes.",
    ...(supportsClarification
      ? [
          "If essential information is missing, run `cohall request-input --question 'Your question'` or the task_request_input MCP tool, then end this turn immediately. Cohall will pause the task and resume it when the sender answers. Do not guess, keep working, or report a final result after requesting input.",
        ]
      : []),
    ...(files === undefined
      ? []
      : [
          ...(files.inputNames.length === 0
            ? []
            : [
                `Input directory: ${files.input}`,
                `Input file names: ${files.inputNames.join(", ")}`,
              ]),
          `Output directory: ${files.output}`,
          "To return files, write at most 2 regular files of up to 256 KiB each in the output directory and mention them in your result.",
        ]),
    `\nTask:\n${task.prompt}${context}`,
    ...(task.clarifications ?? []).flatMap((question) =>
      question.answer === undefined
        ? []
        : [
            `Clarification question:\n${question.question}\nSender's answer:\n${question.answer.text}`,
          ],
    ),
  ].join("\n")
}

const send = (state: State, event: SocketEvent): void => {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(event))
  }
}

const taskRunKey = (taskId: TaskId, runId: TaskRunId | undefined): string =>
  `${taskId}:${runId ?? ""}`

const omitOutputFiles = (event: TaskTerminalEvent, note: string): TaskTerminalEvent => {
  if (event._tag !== "TaskFinished" || (event.attachments?.length ?? 0) === 0) {
    return event
  }
  const message = `\n\n[Output files omitted: ${note}]`
  return SocketEvent.cases.TaskFinished.make({
    _tag: "TaskFinished",
    taskId: event.taskId,
    ...(event.runId === undefined ? {} : { runId: event.runId }),
    result: `${event.result.slice(0, 131_072 - message.length)}${message}`,
    ...(event.providerSessionId === undefined
      ? {}
      : { providerSessionId: event.providerSessionId }),
  })
}

const sendTerminal = (state: State, event: TaskTerminalEvent): void => {
  const safeEvent = state.supportsAttachments
    ? event
    : omitOutputFiles(event, "the relay does not support attachments. Upgrade the relay and retry.")
  state.terminal.set(taskRunKey(event.taskId, event.runId), safeEvent)
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(safeEvent))
  }
}

const sendOperationTerminal = (
  state: State,
  operationId: OperationId,
  event: SocketEvent,
): void => {
  const payload = JSON.stringify(event)
  state.operationTerminal.set(operationId, payload)
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(payload)
  }
}

const remember = (state: State, task: Pick<Task, "id" | "runId">): void => {
  state.completed.add(taskRunKey(task.id, task.runId))
  if (state.completed.size <= 1_000) {
    return
  }
  const oldest = state.completed.keys().next()
  if (!oldest.done) {
    state.completed.delete(oldest.value)
    state.terminal.delete(oldest.value)
  }
}

const rememberOperation = (state: State, operationId: OperationId): void => {
  state.completedOperations.add(operationId)
  if (state.completedOperations.size <= 100) {
    return
  }
  const oldest = state.completedOperations.values().next()
  if (!oldest.done) {
    state.completedOperations.delete(oldest.value)
    state.operationTerminal.delete(oldest.value)
  }
}

const sessionKey = (task: Task): string => `${task.threadId}:${task.provider}`
const hasCompletedRun = (state: State, task: Task): boolean =>
  state.completed.has(taskRunKey(task.id, task.runId))

const drain = (configuration: DeviceConfiguration, state: State): void => {
  if (state.stopping || state.operation !== undefined) {
    return
  }
  if (state.tasks.size === 0) {
    const operation = state.operationQueue.shift()
    if (operation !== undefined) {
      executeOperation(configuration, state, operation)
      return
    }
  }
  const occupied = new Set([...state.tasks.values()].map(({ task }) => taskSlot(task)))
  for (let index = 0; index < state.queue.length; ) {
    const next = state.queue[index]
    if (next === undefined || occupied.has(taskSlot(next))) {
      index += 1
      continue
    }
    state.queue.splice(index, 1)
    occupied.add(taskSlot(next))
    execute(configuration, state, next)
  }
}

const execute = (configuration: DeviceConfiguration, state: State, task: Task): void => {
  if (state.tasks.has(task.id) || hasCompletedRun(state, task)) {
    return
  }
  const controller = new AbortController()
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  const enforceDeadline = (): void => {
    if (task.expiresAt === undefined) return
    const remaining = Date.parse(task.expiresAt) - Date.now()
    if (remaining <= 0) {
      controller.abort()
      return
    }
    deadlineTimer = setTimeout(enforceDeadline, Math.min(remaining, 2_147_483_647))
  }
  enforceDeadline()
  send(
    state,
    SocketEvent.make({
      _tag: "TaskAccepted",
      taskId: task.id,
      ...(task.runId === undefined ? {} : { runId: task.runId }),
    }),
  )

  const workflow: Effect.Effect<
    Providers.RunResult & {
      readonly attachments?: ReadonlyArray<InputAttachment>
      readonly question?: RequestTaskInput["question"]
    },
    Providers.ProviderError
  > = Effect.scoped(
    Effect.gen(function* () {
      if (task.provider === "grok-bot") {
        return yield* Effect.tryPromise({
          try: (signal) =>
            runGrokBot(configuration.grokGateway, task, signal, state.supportsClarification),
          catch: (cause) =>
            new Providers.ProviderRunError({
              provider: task.provider,
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        })
      }
      const provider = task.provider
      if (!state.supportsAttachments && (task.inputAttachmentNames?.length ?? 0) > 0) {
        return yield* new Providers.ProviderRunError({
          provider,
          message: "The relay does not support task file attachments",
        })
      }
      const workspace = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => openAllowedWorkspace(configuration, task.workspace),
          catch: (cause) =>
            new Providers.ProviderRunError({
              provider,
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        }),
        (workspace) => Effect.promise(() => workspace.close().catch(() => undefined)),
      )
      const files = state.supportsAttachments
        ? yield* prepareTaskFiles(configuration, task.id, task.inputAttachmentNames ?? []).pipe(
            Effect.mapError(
              (cause) =>
                new Providers.ProviderRunError({
                  provider,
                  message: cause instanceof Error ? cause.message : String(cause),
                }),
            ),
          )
        : undefined
      const sessionId = task.providerSessionId ?? state.sessions.get(sessionKey(task))
      return yield* Providers.run({
        provider,
        threadId: task.threadId,
        taskId: task.id,
        prompt: promptFor(task, configuration.name, state.supportsClarification, files),
        cwd: workspace.cwd,
        beforeSpawn: workspace.validate,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(task.runId === undefined ? {} : { runId: task.runId }),
        ...(configuration.model === undefined ? {} : { model: configuration.model }),
        ...(configuration.sandbox === undefined ? {} : { sandbox: configuration.sandbox }),
      }).pipe(
        Effect.flatMap((result) =>
          files === undefined
            ? Effect.succeed(result)
            : Effect.tryPromise({
                try: async () => ({ ...result, attachments: await files.collectOutputs() }),
                catch: (cause) =>
                  new Providers.ProviderRunError({
                    provider,
                    message: cause instanceof Error ? cause.message : String(cause),
                  }),
              }).pipe(Effect.uninterruptible),
        ),
      )
    }),
  )

  const done = Effect.runPromise(workflow, { signal: controller.signal })
    .then((result) => {
      let finished: TaskTerminalEvent
      if (result.question !== undefined) {
        if (!state.supportsClarification || task.runId === undefined)
          throw new Error("Upgrade the relay before requesting clarification")
        finished = SocketEvent.cases.TaskInputRequested.make({
          _tag: "TaskInputRequested",
          taskId: task.id,
          runId: task.runId,
          question: result.question,
        })
      } else {
        finished = SocketEvent.cases.TaskFinished.make({
          _tag: "TaskFinished",
          taskId: task.id,
          ...(task.runId === undefined ? {} : { runId: task.runId }),
          result: result.result,
          ...(result.sessionId === undefined ? {} : { providerSessionId: result.sessionId }),
          ...(result.attachments === undefined || result.attachments.length === 0
            ? {}
            : { attachments: result.attachments }),
        })
      }
      const bounded =
        Buffer.byteLength(JSON.stringify(finished)) > maxSocketPayloadBytes
          ? omitOutputFiles(
              finished,
              "the combined result exceeded the 1 MiB transfer limit. Shorten the result or files and retry.",
            )
          : finished
      if (result.sessionId !== undefined) {
        state.sessions.set(sessionKey(task), result.sessionId)
      }
      remember(state, task)
      sendTerminal(state, bounded)
    })
    .catch((cause: unknown) => {
      remember(state, task)
      sendTerminal(
        state,
        controller.signal.aborted
          ? SocketEvent.cases.TaskCancelled.make({
              _tag: "TaskCancelled",
              taskId: task.id,
              ...(task.runId === undefined ? {} : { runId: task.runId }),
            })
          : SocketEvent.cases.TaskFailed.make({
              _tag: "TaskFailed",
              taskId: task.id,
              ...(task.runId === undefined ? {} : { runId: task.runId }),
              error: (cause instanceof Error ? cause.message : String(cause)).slice(0, 16_384),
            }),
      )
    })
    .finally(() => {
      clearTimeout(deadlineTimer)
      state.tasks.delete(task.id)
      drain(configuration, state)
    })
  state.tasks.set(task.id, { task, controller, done })
}

const executeOperation = (
  configuration: DeviceConfiguration,
  state: State,
  operation: DeviceOperation,
): void => {
  if (state.operation !== undefined || state.completedOperations.has(operation.id)) {
    return
  }
  state.operation = operation
  send(state, SocketEvent.make({ _tag: "OperationAccepted", operationId: operation.id }))
  void performDeviceOperation(operation, version)
    .then((result) => {
      rememberOperation(state, operation.id)
      sendOperationTerminal(
        state,
        operation.id,
        SocketEvent.make({
          _tag: "OperationFinished",
          operationId: operation.id,
          result,
        }),
      )
    })
    .catch((cause: unknown) => {
      rememberOperation(state, operation.id)
      sendOperationTerminal(
        state,
        operation.id,
        SocketEvent.make({
          _tag: "OperationFailed",
          operationId: operation.id,
          error: (cause instanceof Error ? cause.message : String(cause)).slice(0, 16_384),
        }),
      )
    })
    .finally(() => {
      state.operation = undefined
      drain(configuration, state)
    })
}

const scheduleOperation = (
  configuration: DeviceConfiguration,
  state: State,
  operation: DeviceOperation,
): void => {
  if (state.stopping) return
  if (
    state.completedOperations.has(operation.id) ||
    state.operation?.id === operation.id ||
    state.operationQueue.some((pending) => pending.id === operation.id)
  ) {
    return
  }
  if (state.tasks.size > 0 || state.operation !== undefined) {
    if (state.operationQueue.length >= 10) {
      state.socket?.close(4008, "Operation queue limit reached")
      return
    }
    state.operationQueue.push(operation)
    return
  }
  executeOperation(configuration, state, operation)
}

export const performDeviceOperation = (
  operation: DeviceOperation,
  currentVersion: string,
  runUpgrade: (options: UpgradeOptions) => Promise<UpgradeResult> = upgrade,
): Promise<string> =>
  runUpgrade({
    currentVersion,
    target: operation.requestedVersion,
    restart: operation.restart,
    dryRun: false,
    delegated: true,
  }).then((result) => JSON.stringify(result))

const schedule = (configuration: DeviceConfiguration, state: State, task: Task): void => {
  if (state.stopping) return
  if (
    (state.tasks.get(task.id)?.task.runId === task.runId && state.tasks.has(task.id)) ||
    hasCompletedRun(state, task) ||
    state.queue.some((queued) => queued.id === task.id && queued.runId === task.runId)
  ) {
    return
  }
  if (task.providerSessionId !== undefined) {
    state.sessions.set(sessionKey(task), task.providerSessionId)
  }
  if (
    [...state.tasks.values()].some(({ task: active }) => taskSlot(active) === taskSlot(task)) ||
    state.operation !== undefined
  ) {
    if (state.queue.length >= 100) {
      state.socket?.close(4008, "Task queue limit reached")
      return
    }
    state.queue.push(task)
    return
  }
  execute(configuration, state, task)
}

const cancel = (state: State, taskId: TaskId, runId?: TaskRunId): void => {
  const running = state.tasks.get(taskId)
  if (running !== undefined && (runId === undefined || running.task.runId === runId)) {
    if (running.task.provider !== "grok-bot") {
      running.controller.abort()
    }
    return
  }
  const index = state.queue.findIndex(
    (task) => task.id === taskId && (runId === undefined || task.runId === runId),
  )
  if (index !== -1) {
    state.queue.splice(index, 1)
  }
  remember(state, { id: taskId, ...(runId === undefined ? {} : { runId }) })
  sendTerminal(
    state,
    SocketEvent.cases.TaskCancelled.make({
      _tag: "TaskCancelled",
      taskId,
      ...(runId === undefined ? {} : { runId }),
    }),
  )
}

const connect = (
  configuration: DeviceConfiguration,
  state: State,
): Effect.Effect<void, DeviceConnectionError> =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<void>((complete) => {
        const socket = new WebSocket(socketUrl(configuration), {
          maxPayload: maxSocketPayloadBytes,
          perMessageDeflate: false,
          allowSynchronousEvents: false,
        })
        let bots: ReadonlyArray<Bot> = []
        let refreshing = false
        const refreshBots = async (): Promise<void> => {
          if (
            refreshing ||
            configuration.grokGateway === undefined ||
            (configuration.providers !== undefined && !configuration.providers.includes("grok-bot"))
          ) {
            return
          }
          refreshing = true
          bots = await discoverGrokBots(configuration.grokGateway).catch(() => [])
          refreshing = false
          if (!closed) {
            send(
              state,
              SocketEvent.make({
                _tag: "DeviceHeartbeat",
                deviceId: configuration.id,
                status: state.tasks.size > 0 || state.operation !== undefined ? "busy" : "online",
                bots,
              }),
            )
          }
        }
        const heartbeat = setInterval(() => {
          send(
            state,
            SocketEvent.make({
              _tag: "DeviceHeartbeat",
              deviceId: configuration.id,
              status: state.tasks.size > 0 || state.operation !== undefined ? "busy" : "online",
              ...(configuration.grokGateway === undefined ? {} : { bots }),
            }),
          )
          void refreshBots()
        }, 15_000)
        let closed = false
        let queuedMessages = 0
        const close = (): void => {
          if (closed) {
            return
          }
          closed = true
          clearInterval(heartbeat)
          if (state.socket === socket) {
            state.socket = undefined
          }
          complete()
        }
        signal.addEventListener(
          "abort",
          () => {
            socket.close()
            close()
          },
          { once: true },
        )
        socket.once("open", () => {
          socket.send(
            JSON.stringify(SocketEvent.make({ _tag: "Authenticate", token: configuration.token })),
          )
        })
        socket.on("message", (message: RawData) => {
          if (queuedMessages >= maxQueuedRelayMessages) {
            socket.close(4008, "Message queue limit reached")
            return
          }
          queuedMessages += 1
          state.processing = state.processing
            .then(async () => {
              if (closed) {
                return
              }
              const text = Buffer.isBuffer(message)
                ? message.toString("utf8")
                : message instanceof ArrayBuffer
                  ? Buffer.from(message).toString("utf8")
                  : Array.isArray(message)
                    ? Buffer.concat(message).toString("utf8")
                    : Buffer.from(message).toString("utf8")
              const event = await Effect.runPromise(
                Effect.try({
                  try: () => JSON.parse(text) as unknown,
                  catch: () => new DeviceConnectionError({ message: "Relay sent invalid JSON" }),
                }).pipe(Effect.flatMap(decodeSocketEvent)),
              )
              if (event._tag === "Connected") {
                state.supportsAttachments = event.taskAttachments === true
                state.supportsClarification = event.taskClarification === true
                state.socket = socket
                socket.send(
                  JSON.stringify(
                    SocketEvent.make({
                      _tag: "DeviceHello",
                      device: describeDevice(
                        configuration,
                        state.tasks.size > 0 || state.operation !== undefined ? "busy" : "online",
                        bots,
                      ),
                    }),
                  ),
                )
                for (const [key, pending] of state.terminal) {
                  const safeEvent = state.supportsAttachments
                    ? pending
                    : omitOutputFiles(
                        pending,
                        "the relay does not support attachments. Upgrade the relay and retry.",
                      )
                  state.terminal.set(key, safeEvent)
                  socket.send(JSON.stringify(safeEvent))
                }
                for (const payload of state.operationTerminal.values()) {
                  socket.send(payload)
                }
                void refreshBots()
                return
              }
              if (event._tag === "TaskAssigned") {
                schedule(configuration, state, event.task)
                return
              }
              if (event._tag === "CancelTask") {
                cancel(state, event.taskId, event.runId)
                return
              }
              if (event._tag === "TaskSettled") {
                state.terminal.delete(taskRunKey(event.taskId, event.runId))
                void cleanupBotReply(event.taskId, event.runId).catch(() => {
                  console.error(`Could not remove local bot reply for settled task ${event.taskId}`)
                })
                return
              }
              if (event._tag === "OperationAssigned") {
                scheduleOperation(configuration, state, event.operation)
                return
              }
              if (event._tag === "OperationSettled") {
                state.operationTerminal.delete(event.operationId)
                return
              }
              if (event._tag === "Error") {
                console.error(`Relay error: ${event.message}`)
              }
            })
            .catch((cause: unknown) => {
              console.error(
                `Invalid relay event: ${cause instanceof Error ? cause.message : String(cause)}`,
              )
            })
            .finally(() => {
              queuedMessages = Math.max(0, queuedMessages - 1)
            })
        })
        socket.once("close", close)
        socket.once("error", () => socket.close())
      }),
    catch: (cause) =>
      new DeviceConnectionError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  })

export const runDaemon = (
  configuration: DeviceConfiguration,
): Effect.Effect<void, DeviceConnectionError> => {
  const state: State = {
    socket: undefined,
    stopping: false,
    supportsAttachments: false,
    supportsClarification: false,
    processing: Promise.resolve(),
    terminal: new Map(),
    queue: [],
    sessions: new Map(),
    tasks: new Map(),
    completed: new Set(),
    operation: undefined,
    operationQueue: [],
    operationTerminal: new Map(),
    completedOperations: new Set(),
  }
  return connect(configuration, state).pipe(
    Effect.repeat({ schedule: Schedule.spaced("2 seconds") }),
    Effect.ensuring(
      Effect.promise(async () => {
        state.stopping = true
        state.socket?.close()
        const running = [...state.tasks.values()]
        for (const { controller } of running) {
          controller.abort()
        }
        await Promise.allSettled(running.map(({ done }) => done))
      }),
    ),
  )
}
