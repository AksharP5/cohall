import {
  Device,
  SocketEvent,
  decodeSocketEvent,
  now,
  type ProviderEvent,
  type Task,
  type TaskId,
} from "@cohall/protocol"
import * as Codex from "@cohall/provider-codex"
import { Effect, Schedule, Schema } from "effect"
import { arch, hostname, platform } from "node:os"
import { isAbsolute, relative, resolve } from "node:path"
import type { DeviceConfiguration } from "./config.ts"

export class DeviceConnectionError extends Schema.TaggedErrorClass<DeviceConnectionError>()(
  "Device.ConnectionError",
  {
    message: Schema.String,
  },
) {}

interface State {
  socket: WebSocket | undefined
  readonly pending: Array<string>
  readonly queue: Array<Task>
  readonly sessions: Map<string, string>
  readonly tasks: Map<TaskId, AbortController>
  readonly completed: Set<TaskId>
}

const socketUrl = (configuration: DeviceConfiguration): string => {
  const url = new URL(configuration.relayUrl)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.pathname = "/ws"
  url.searchParams.set("role", "device")
  return url.toString()
}

const capabilities = (): Device["capabilities"] => {
  const values: Array<Device["capabilities"][number]> = []
  if (Codex.available()) {
    values.push({
      id: "codex",
      label: "Codex",
      detail: "Uses the device's local Codex login and tools",
    })
  }
  if (
    Bun.which("google-chrome") !== null ||
    Bun.which("chromium") !== null ||
    platform() === "darwin"
  ) {
    values.push({
      id: "browser-session",
      label: "Signed-in browser",
      detail: "Local browser state can be used by configured Codex tools",
    })
  }
  if (Bun.which("xcodebuild") !== null) {
    values.push({
      id: "xcode",
      label: "Xcode",
      detail: "Build and test Apple platform projects",
    })
  }
  if (Bun.which("docker") !== null) {
    values.push({ id: "docker", label: "Docker" })
  }
  return values
}

const device = (
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

  return Device.make({
    id: configuration.id,
    name: configuration.name,
    hostname: hostname(),
    platform: platformName,
    architecture: arch(),
    status,
    providers: Codex.available() ? ["codex"] : [],
    capabilities: capabilities(),
    workspaces: configuration.workspaces.map((path) => ({
      path,
      label: path.split("/").at(-1) ?? path,
    })),
    version: "0.1.0",
    lastSeenAt: now(),
  })
}

const allowedWorkspace = (
  configuration: DeviceConfiguration,
  requested: string | undefined,
): string => {
  if (requested === undefined) {
    const first = configuration.workspaces[0]
    if (first === undefined) {
      throw new Error("No workspace is configured on this device")
    }
    return first
  }
  const candidate = resolve(requested)
  const allowed = configuration.workspaces.some((root) => {
    const child = relative(root, candidate)
    return child === "" || (!child.startsWith("..") && !isAbsolute(child))
  })
  if (!allowed) {
    throw new Error(`Workspace ${candidate} is outside this device's configured workspace roots`)
  }
  return candidate
}

const promptFor = (task: Task, deviceName: string): string => {
  const context =
    task.context === undefined
      ? ""
      : `\n\nRelevant context supplied by the sending agent:\n${task.context}`
  return [
    `You are the Cohall agent running on ${deviceName}.`,
    "Complete the delegated task using this device's local workspace, tools, credentials, and signed-in services.",
    "Do not ask the human to copy information between devices. Return a concise but complete result that the sending agent can act on.",
    `\nTask:\n${task.prompt}${context}`,
  ].join("\n")
}

const send = (state: State, event: SocketEvent): void => {
  const payload = JSON.stringify(event)
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(payload)
    return
  }
  state.pending.push(payload)
}

const remember = (state: State, taskId: TaskId): void => {
  state.completed.add(taskId)
  if (state.completed.size <= 1_000) {
    return
  }
  const oldest = state.completed.values().next()
  if (!oldest.done) {
    state.completed.delete(oldest.value)
  }
}

const sessionKey = (task: Task): string => `${task.threadId}:${task.provider}`

const execute = (configuration: DeviceConfiguration, state: State, task: Task): void => {
  if (state.tasks.has(task.id) || state.completed.has(task.id)) {
    return
  }
  const controller = new AbortController()
  state.tasks.set(task.id, controller)
  send(
    state,
    SocketEvent.make({
      _tag: "TaskAccepted",
      taskId: task.id,
      acceptedAt: now(),
    }),
  )

  const onEvent = (event: ProviderEvent): void => {
    send(
      state,
      SocketEvent.make({
        _tag: "TaskProgress",
        taskId: task.id,
        event,
        sentAt: now(),
      }),
    )
  }

  const workflow = Effect.gen(function* () {
    const cwd = yield* Effect.try({
      try: () => allowedWorkspace(configuration, task.workspace),
      catch: (cause) =>
        new Codex.CodexRunError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    })
    const sessionId = task.providerSessionId ?? state.sessions.get(sessionKey(task))
    return yield* Codex.run({
      threadId: task.threadId,
      prompt: promptFor(task, configuration.name),
      cwd,
      onEvent,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(configuration.model === undefined ? {} : { model: configuration.model }),
      ...(configuration.sandbox === undefined ? {} : { sandbox: configuration.sandbox }),
    })
  })

  void Effect.runPromise(workflow, { signal: controller.signal })
    .then((result) => {
      if (result.sessionId !== undefined) {
        state.sessions.set(sessionKey(task), result.sessionId)
      }
      remember(state, task.id)
      send(
        state,
        SocketEvent.make({
          _tag: "TaskFinished",
          taskId: task.id,
          result: result.result,
          finishedAt: now(),
          ...(result.sessionId === undefined ? {} : { providerSessionId: result.sessionId }),
        }),
      )
    })
    .catch((cause: unknown) => {
      remember(state, task.id)
      if (controller.signal.aborted) {
        send(
          state,
          SocketEvent.make({
            _tag: "TaskCancelled",
            taskId: task.id,
            cancelledAt: now(),
          }),
        )
        return
      }
      send(
        state,
        SocketEvent.make({
          _tag: "TaskFailed",
          taskId: task.id,
          error: cause instanceof Error ? cause.message : String(cause),
          finishedAt: now(),
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
  if (index === -1) {
    return
  }
  state.queue.splice(index, 1)
  remember(state, taskId)
  send(
    state,
    SocketEvent.make({
      _tag: "TaskCancelled",
      taskId,
      cancelledAt: now(),
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
        const socket = new WebSocket(socketUrl(configuration))
        const heartbeat = setInterval(() => {
          send(
            state,
            SocketEvent.make({
              _tag: "DeviceHeartbeat",
              deviceId: configuration.id,
              status: state.tasks.size > 0 ? "busy" : "online",
              sentAt: now(),
            }),
          )
        }, 15_000)

        const close = (): void => {
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
        socket.addEventListener("open", () => {
          socket.send(
            JSON.stringify(
              SocketEvent.make({
                _tag: "Authenticate",
                token: configuration.token,
                role: "device",
              }),
            ),
          )
        })
        socket.addEventListener("message", (message) => {
          if (typeof message.data !== "string") {
            return
          }
          void Effect.runPromise(
            Effect.try({
              try: () => JSON.parse(message.data) as unknown,
              catch: () =>
                new DeviceConnectionError({
                  message: "Relay sent invalid JSON",
                }),
            }).pipe(Effect.flatMap(decodeSocketEvent)),
          )
            .then((event) => {
              if (event._tag === "Connected") {
                state.socket = socket
                socket.send(
                  JSON.stringify(
                    SocketEvent.make({
                      _tag: "DeviceHello",
                      device: device(configuration, state.tasks.size > 0 ? "busy" : "online"),
                    }),
                  ),
                )
                for (const payload of state.pending.splice(0)) {
                  socket.send(payload)
                }
                console.log(`Connected ${configuration.name} to ${configuration.relayUrl}`)
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
              if (event._tag === "Error") {
                console.error(`Relay error: ${event.message}`)
              }
            })
            .catch((cause: unknown) => {
              console.error(
                `Ignored invalid relay event: ${cause instanceof Error ? cause.message : String(cause)}`,
              )
            })
        })
        socket.addEventListener("close", close, { once: true })
        socket.addEventListener("error", () => {
          socket.close()
        })
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
    pending: [],
    queue: [],
    sessions: new Map(),
    tasks: new Map(),
    completed: new Set(),
  }
  return connect(configuration, state).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
    }),
  )
}
