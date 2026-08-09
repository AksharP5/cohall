import {
  Device,
  SocketEvent,
  decodeSocketEvent,
  maxSocketPayloadBytes,
  now,
  version,
  type Provider,
  type Task,
  type TaskId,
} from "@cohall/protocol"
import * as Providers from "@cohall/providers"
import { Effect, Schedule, Schema } from "effect"
import { constants } from "node:fs"
import { open, realpath, stat } from "node:fs/promises"
import { arch, hostname, platform } from "node:os"
import { basename, isAbsolute, relative } from "node:path"
import { WebSocket, type RawData } from "ws"
import type { DeviceConfiguration } from "./config.ts"

const maxQueuedRelayMessages = 8

export class DeviceConnectionError extends Schema.TaggedErrorClass<DeviceConnectionError>()(
  "Device.ConnectionError",
  { message: Schema.String },
) {}

interface State {
  socket: WebSocket | undefined
  processing: Promise<void>
  readonly terminal: Map<TaskId, string>
  readonly queue: Array<Task>
  readonly sessions: Map<string, string>
  readonly tasks: Map<TaskId, AbortController>
  readonly completed: Set<TaskId>
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
  }
}

const capabilities = (providers: ReadonlyArray<Provider>): Device["capabilities"] => {
  const values: Array<Device["capabilities"][number]> = providers.map((provider) => ({
    id: provider,
    label: providerLabel(provider),
    detail: `${providerLabel(provider)} executable detected; authentication is checked when work starts`,
  }))
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
): Device => {
  const operatingSystem = platform()
  const platformName =
    operatingSystem === "darwin" || operatingSystem === "linux"
      ? operatingSystem
      : operatingSystem === "win32"
        ? "windows"
        : "unknown"
  const installed = Providers.availableProviders()
  const providers = selectProviders(installed, configuration.providers)
  return Device.make({
    id: configuration.id,
    name: configuration.name,
    hostname: hostname(),
    platform: platformName,
    architecture: arch(),
    status,
    providers,
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

const promptFor = (task: Task, deviceName: string): string => {
  const context =
    task.context === undefined
      ? ""
      : `\n\nRelevant context supplied by the sending agent:\n${task.context}`
  return [
    `You are the Cohall agent running on ${deviceName}.`,
    "Complete the delegated task using this device's local workspace, tools, credentials, and signed-in services.",
    "Never read, reveal, copy, or use Cohall configuration files or Cohall authentication tokens.",
    "Return a concise, complete result with the evidence the sending agent needs.",
    `\nTask:\n${task.prompt}${context}`,
  ].join("\n")
}

const send = (state: State, event: SocketEvent): void => {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(event))
  }
}

const sendTerminal = (state: State, taskId: TaskId, event: SocketEvent): void => {
  const payload = JSON.stringify(event)
  state.terminal.set(taskId, payload)
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(payload)
  }
}

const remember = (state: State, taskId: TaskId): void => {
  state.completed.add(taskId)
  if (state.completed.size <= 1_000) {
    return
  }
  const oldest = state.completed.values().next()
  if (!oldest.done) {
    state.completed.delete(oldest.value)
    state.terminal.delete(oldest.value)
  }
}

const sessionKey = (task: Task): string => `${task.threadId}:${task.provider}`

const execute = (configuration: DeviceConfiguration, state: State, task: Task): void => {
  if (state.tasks.has(task.id) || state.completed.has(task.id)) {
    return
  }
  const controller = new AbortController()
  state.tasks.set(task.id, controller)
  send(state, SocketEvent.make({ _tag: "TaskAccepted", taskId: task.id }))

  const workflow = Effect.gen(function* () {
    const workspace = yield* Effect.tryPromise({
      try: () => openAllowedWorkspace(configuration, task.workspace),
      catch: (cause) =>
        new Providers.ProviderRunError({
          provider: task.provider,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    })
    const sessionId = task.providerSessionId ?? state.sessions.get(sessionKey(task))
    return yield* Providers.run({
      provider: task.provider,
      threadId: task.threadId,
      prompt: promptFor(task, configuration.name),
      cwd: workspace.cwd,
      beforeSpawn: workspace.validate,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(configuration.model === undefined ? {} : { model: configuration.model }),
      ...(configuration.sandbox === undefined ? {} : { sandbox: configuration.sandbox }),
    }).pipe(Effect.ensuring(Effect.promise(() => workspace.close().catch(() => undefined))))
  })

  void Effect.runPromise(workflow, { signal: controller.signal })
    .then((result) => {
      if (result.sessionId !== undefined) {
        state.sessions.set(sessionKey(task), result.sessionId)
      }
      remember(state, task.id)
      sendTerminal(
        state,
        task.id,
        SocketEvent.make({
          _tag: "TaskFinished",
          taskId: task.id,
          result: result.result,
          ...(result.sessionId === undefined ? {} : { providerSessionId: result.sessionId }),
        }),
      )
    })
    .catch((cause: unknown) => {
      remember(state, task.id)
      sendTerminal(
        state,
        task.id,
        controller.signal.aborted
          ? SocketEvent.make({ _tag: "TaskCancelled", taskId: task.id })
          : SocketEvent.make({
              _tag: "TaskFailed",
              taskId: task.id,
              error: (cause instanceof Error ? cause.message : String(cause)).slice(0, 16_384),
            }),
      )
    })
    .finally(() => {
      state.tasks.delete(task.id)
      const next = state.queue.shift()
      if (next !== undefined) {
        execute(configuration, state, next)
      }
    })
}

const schedule = (configuration: DeviceConfiguration, state: State, task: Task): void => {
  if (
    state.tasks.has(task.id) ||
    state.completed.has(task.id) ||
    state.queue.some((queued) => queued.id === task.id)
  ) {
    return
  }
  if (task.providerSessionId !== undefined) {
    state.sessions.set(sessionKey(task), task.providerSessionId)
  }
  if (state.tasks.size > 0) {
    if (state.queue.length >= 100) {
      state.socket?.close(4008, "Task queue limit reached")
      return
    }
    state.queue.push(task)
    return
  }
  execute(configuration, state, task)
}

const cancel = (state: State, taskId: TaskId): void => {
  const running = state.tasks.get(taskId)
  if (running !== undefined) {
    running.abort()
    return
  }
  const index = state.queue.findIndex((task) => task.id === taskId)
  if (index !== -1) {
    state.queue.splice(index, 1)
  }
  remember(state, taskId)
  sendTerminal(state, taskId, SocketEvent.make({ _tag: "TaskCancelled", taskId }))
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
        })
        const heartbeat = setInterval(() => {
          send(
            state,
            SocketEvent.make({
              _tag: "DeviceHeartbeat",
              deviceId: configuration.id,
              status: state.tasks.size > 0 ? "busy" : "online",
            }),
          )
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
                state.socket = socket
                socket.send(
                  JSON.stringify(
                    SocketEvent.make({
                      _tag: "DeviceHello",
                      device: describeDevice(
                        configuration,
                        state.tasks.size > 0 ? "busy" : "online",
                      ),
                    }),
                  ),
                )
                for (const payload of state.terminal.values()) {
                  socket.send(payload)
                }
                return
              }
              if (event._tag === "TaskAssigned") {
                schedule(configuration, state, event.task)
                return
              }
              if (event._tag === "CancelTask") {
                cancel(state, event.taskId)
                return
              }
              if (event._tag === "TaskSettled") {
                state.terminal.delete(event.taskId)
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
    processing: Promise.resolve(),
    terminal: new Map(),
    queue: [],
    sessions: new Map(),
    tasks: new Map(),
    completed: new Set(),
  }
  return connect(configuration, state).pipe(
    Effect.repeat({ schedule: Schedule.spaced("2 seconds") }),
    Effect.ensuring(
      Effect.sync(() => {
        state.socket?.close()
        for (const controller of state.tasks.values()) {
          controller.abort()
        }
      }),
    ),
  )
}
