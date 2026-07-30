import {
  Device,
  DeviceId,
  SocketEvent,
  TaskId,
  ThreadId,
  decodeCreateMessageInput,
  decodeCreateTaskInput,
  decodeCreateThreadInput,
  decodeSocketEvent,
  isTerminalTask,
  now,
  type CreateTaskInput,
  type ProviderEvent,
  type Task,
} from "@cohall/protocol"
import { Effect, ManagedRuntime, Schema } from "effect"
import { mkdir } from "node:fs/promises"
import { dirname, join, normalize, relative } from "node:path"
import { loadEnvironmentConfiguration } from "./config.ts"
import { Hub, type ConnectionData } from "./hub.ts"
import { RelayStore } from "./store.ts"

const version = "0.1.0"

class RequestError extends Schema.TaggedErrorClass<RequestError>()("Relay.RequestError", {
  status: Schema.Int,
  message: Schema.String,
}) {}

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
}

const json = (value: unknown, status = 200): Response =>
  Response.json(value, {
    status,
    headers: corsHeaders,
  })

const body = <A, E, R>(
  request: Request,
  decode: (input: unknown) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | RequestError, R> =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => new RequestError({ status: 400, message: "Expected a JSON request body" }),
  }).pipe(
    Effect.flatMap(decode),
    Effect.mapError((cause) =>
      cause instanceof RequestError
        ? cause
        : new RequestError({ status: 400, message: String(cause) }),
    ),
  )

const pathId = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  value: string,
): Effect.Effect<S["Type"], RequestError> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      () => new RequestError({ status: 400, message: `Invalid identifier: ${value}` }),
    ),
  )

const chooseDevice = (
  input: CreateTaskInput,
  threadId: ThreadId,
): Effect.Effect<DeviceId, RequestError, RelayStore.Service> =>
  Effect.gen(function* () {
    if (input.targetDeviceId !== undefined) {
      const store = yield* RelayStore.Service
      const devices = yield* store
        .listDevices()
        .pipe(Effect.mapError((cause) => new RequestError({ status: 500, message: cause.message })))
      const target = devices.find((device) => device.id === input.targetDeviceId)
      if (target === undefined) {
        return yield* Effect.fail(
          new RequestError({
            status: 404,
            message: `Unknown target device ${input.targetDeviceId}`,
          }),
        )
      }
      if (!target.providers.includes(input.provider ?? "codex")) {
        return yield* Effect.fail(
          new RequestError({
            status: 409,
            message: `${target.name} does not advertise the ${input.provider ?? "codex"} provider`,
          }),
        )
      }
      return target.id
    }

    const store = yield* RelayStore.Service
    const [thread, devices] = yield* Effect.all([
      store.getThread(threadId),
      store.listDevices(),
    ]).pipe(Effect.mapError((cause) => new RequestError({ status: 404, message: cause.message })))

    if (thread.defaultDeviceId !== undefined) {
      return thread.defaultDeviceId
    }

    const candidates = devices.filter((device) =>
      device.providers.includes(input.provider ?? "codex"),
    )
    const prompt = `${input.prompt} ${input.context ?? ""}`.toLowerCase()
    const needsXcode = /\b(xcode|ios|macos|swiftui|app store)\b/.test(prompt)
    const needsBrowser =
      /\b(browser|chrome|youtube|twitter|logged[- ]?in|signed[- ]?in|x\.com)\b/.test(prompt)
    const score = (device: Device): number =>
      (device.status === "offline" ? 0 : 100) +
      (input.workspace !== undefined &&
      device.workspaces.some(
        (workspace) =>
          input.workspace === workspace.path || input.workspace?.startsWith(`${workspace.path}/`),
      )
        ? 80
        : 0) +
      (needsXcode && device.capabilities.some((capability) => capability.id === "xcode") ? 60 : 0) +
      (needsBrowser && device.capabilities.some((capability) => capability.id === "browser-session")
        ? 40
        : 0) +
      (needsBrowser && device.platform === "darwin" ? 12 : 0) +
      (input.sourceDeviceId === device.id ? -5 : 0)
    const selected = [...candidates].sort((left, right) => score(right) - score(left))[0]
    if (selected !== undefined) {
      return selected.id
    }

    return yield* Effect.fail(
      new RequestError({
        status: 409,
        message: "No Cohall device with the requested provider is registered",
      }),
    )
  })

const progressMessage = (
  event: ProviderEvent,
):
  | { readonly content: string; readonly kind: "chat" | "reasoning" | "tool" | "status" }
  | undefined => {
  switch (event._tag) {
    case "AssistantMessage":
      return { content: event.content, kind: "chat" }
    case "Reasoning":
      return { content: event.content, kind: "reasoning" }
    case "ToolStarted":
      return { content: `${event.tool}: ${event.summary}`, kind: "tool" }
    case "ToolCompleted":
      return {
        content: `${event.tool}: ${event.summary}`,
        kind: event.success ? "tool" : "status",
      }
    case "CommandOutput":
      return { content: event.content, kind: "tool" }
    case "SessionStarted":
    case "Usage":
      return undefined
  }
}

const configuration = await Effect.runPromise(loadEnvironmentConfiguration)
await mkdir(dirname(configuration.databasePath), { recursive: true })

const runtime = ManagedRuntime.make(RelayStore.layer(configuration.databasePath))
const hub = new Hub()

const run = <A, E>(effect: Effect.Effect<A, E, RelayStore.Service>): Promise<A> =>
  runtime.runPromise(effect)

const broadcastTask = (task: Task): void => {
  hub.broadcast(SocketEvent.make({ _tag: "TaskChanged", task }))
}

const dispatch = async (task: Task): Promise<Task> => {
  if (!hub.sendToDevice(task.targetDeviceId, SocketEvent.make({ _tag: "TaskAssigned", task }))) {
    return task
  }
  const updated = await run(
    Effect.gen(function* () {
      const store = yield* RelayStore.Service
      return yield* store.updateTask(task.id, { status: "assigned" })
    }),
  )
  broadcastTask(updated)
  return updated
}

const dispatchPending = async (deviceId: DeviceId): Promise<void> => {
  const tasks = await run(
    Effect.gen(function* () {
      const store = yield* RelayStore.Service
      return yield* store.pendingTasksFor(deviceId)
    }),
  )
  for (const task of tasks) {
    await dispatch(task)
  }
}

const createTask = (
  input: CreateTaskInput,
): Effect.Effect<Task, RequestError, RelayStore.Service> =>
  Effect.gen(function* () {
    const store = yield* RelayStore.Service
    const thread =
      input.threadId === undefined
        ? yield* store
            .createThread({
              title: input.title ?? input.prompt.slice(0, 72),
            })
            .pipe(
              Effect.mapError((cause) => new RequestError({ status: 500, message: cause.message })),
            )
        : yield* store
            .getThread(input.threadId)
            .pipe(
              Effect.mapError((cause) => new RequestError({ status: 404, message: cause.message })),
            )
    const targetDeviceId = yield* chooseDevice(input, thread.id)
    const created = yield* store
      .createTask(input, targetDeviceId, thread.id)
      .pipe(Effect.mapError((cause) => new RequestError({ status: 500, message: cause.message })))
    const sessionId = yield* store
      .sessionFor(thread.id, targetDeviceId, input.provider ?? "codex")
      .pipe(Effect.mapError((cause) => new RequestError({ status: 500, message: cause.message })))
    const task =
      sessionId === undefined
        ? created
        : yield* store
            .updateTask(created.id, { providerSessionId: sessionId })
            .pipe(
              Effect.mapError((cause) => new RequestError({ status: 500, message: cause.message })),
            )
    const message = yield* store
      .createMessage(thread.id, {
        content: input.prompt,
        role: "human",
        kind: "chat",
        authorId: input.sourceDeviceId ?? "user",
        authorName: input.sourceDeviceId === undefined ? "You" : "Remote agent",
        taskId: task.id,
        ...(input.sourceDeviceId === undefined ? {} : { deviceId: input.sourceDeviceId }),
      })
      .pipe(Effect.mapError((cause) => new RequestError({ status: 500, message: cause.message })))
    const updatedThread = yield* store
      .getThread(thread.id)
      .pipe(Effect.mapError((cause) => new RequestError({ status: 500, message: cause.message })))

    hub.broadcast(SocketEvent.make({ _tag: "ThreadChanged", thread: updatedThread }))
    hub.broadcast(SocketEvent.make({ _tag: "MessageCreated", message }))
    broadcastTask(task)
    return task
  })

const handleSocketEvent = async (
  socket: Bun.ServerWebSocket<ConnectionData>,
  input: string | Buffer,
): Promise<void> => {
  const event = await Effect.runPromise(
    Effect.try({
      try: () => JSON.parse(input.toString()) as unknown,
      catch: () => new RequestError({ status: 400, message: "Invalid socket JSON" }),
    }).pipe(Effect.flatMap(decodeSocketEvent)),
  ).catch((cause: unknown) => {
    socket.send(
      JSON.stringify(
        SocketEvent.make({
          _tag: "Error",
          code: "invalid_event",
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      ),
    )
    return undefined
  })
  if (event === undefined) {
    return
  }

  if (event._tag === "DeviceHello") {
    if (socket.data.role !== "device") {
      socket.close(4003, "Client sockets cannot register devices")
      return
    }
    const device = Device.make({
      ...event.device,
      status: "online",
      connectedAt: now(),
      lastSeenAt: now(),
    })
    hub.registerDevice(device.id, socket)
    await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        return yield* store.upsertDevice(device)
      }),
    )
    hub.broadcast(SocketEvent.make({ _tag: "DeviceChanged", device }))
    await dispatchPending(device.id)
    return
  }

  const deviceId = hub.deviceId(socket)
  if (deviceId === undefined) {
    socket.send(
      JSON.stringify(
        SocketEvent.make({
          _tag: "Error",
          code: "device_hello_required",
          message: "Send DeviceHello before device events",
        }),
      ),
    )
    return
  }

  await run(
    Effect.gen(function* () {
      const store = yield* RelayStore.Service

      switch (event._tag) {
        case "DeviceHeartbeat": {
          if (event.deviceId !== deviceId) {
            return
          }
          const device = (yield* store.listDevices()).find((candidate) => candidate.id === deviceId)
          if (device === undefined) {
            return
          }
          const updated = yield* store.upsertDevice(
            Device.make({
              ...device,
              status: event.status,
              lastSeenAt: event.sentAt,
            }),
          )
          hub.broadcast(SocketEvent.make({ _tag: "DeviceChanged", device: updated }))
          return
        }
        case "TaskAccepted": {
          const current = yield* store.getTask(event.taskId)
          if (isTerminalTask(current)) {
            return
          }
          const task = yield* store.updateTask(event.taskId, {
            status: "running",
            startedAt: event.acceptedAt,
          })
          broadcastTask(task)
          return
        }
        case "TaskProgress": {
          const task = yield* store.getTask(event.taskId)
          if (isTerminalTask(task)) {
            return
          }
          if (event.event._tag === "SessionStarted") {
            yield* store.saveSession(
              task.threadId,
              task.targetDeviceId,
              task.provider,
              event.event.sessionId,
            )
            const updated = yield* store.updateTask(task.id, {
              providerSessionId: event.event.sessionId,
            })
            broadcastTask(updated)
          }
          const detail = progressMessage(event.event)
          if (detail === undefined) {
            return
          }
          const message = yield* store.createMessage(task.threadId, {
            content: detail.content,
            kind: detail.kind,
            role: detail.kind === "tool" ? "tool" : "agent",
            authorId: deviceId,
            authorName: "Codex",
            taskId: task.id,
            deviceId,
          })
          hub.broadcast(SocketEvent.make({ _tag: "MessageCreated", message }))
          return
        }
        case "TaskFinished": {
          const current = yield* store.getTask(event.taskId)
          if (isTerminalTask(current)) {
            return
          }
          const task = yield* store.updateTask(event.taskId, {
            status: "completed",
            result: event.result,
            completedAt: event.finishedAt,
            ...(event.providerSessionId === undefined
              ? {}
              : { providerSessionId: event.providerSessionId }),
          })
          if (event.providerSessionId !== undefined) {
            yield* store.saveSession(
              task.threadId,
              task.targetDeviceId,
              task.provider,
              event.providerSessionId,
            )
          }
          const message = yield* store.createMessage(task.threadId, {
            content: event.result,
            kind: "chat",
            role: "agent",
            authorId: deviceId,
            authorName: "Codex",
            taskId: task.id,
            deviceId,
          })
          hub.broadcast(SocketEvent.make({ _tag: "MessageCreated", message }))
          broadcastTask(task)
          return
        }
        case "TaskFailed": {
          const current = yield* store.getTask(event.taskId)
          if (isTerminalTask(current)) {
            return
          }
          const task = yield* store.updateTask(event.taskId, {
            status: "failed",
            error: event.error,
            completedAt: event.finishedAt,
          })
          const message = yield* store.createMessage(task.threadId, {
            content: event.error,
            kind: "error",
            role: "system",
            authorId: deviceId,
            authorName: "Cohall",
            taskId: task.id,
            deviceId,
          })
          hub.broadcast(SocketEvent.make({ _tag: "MessageCreated", message }))
          broadcastTask(task)
          return
        }
        case "TaskCancelled": {
          const current = yield* store.getTask(event.taskId)
          if (isTerminalTask(current)) {
            return
          }
          const task = yield* store.updateTask(event.taskId, {
            status: "cancelled",
            completedAt: event.cancelledAt,
          })
          broadcastTask(task)
          return
        }
        case "Connected":
        case "CancelTask":
        case "DeviceChanged":
        case "ThreadChanged":
        case "MessageCreated":
        case "TaskChanged":
        case "ArtifactCreated":
        case "Error":
          return
      }
    }),
  ).catch((cause: unknown) => {
    socket.send(
      JSON.stringify(
        SocketEvent.make({
          _tag: "Error",
          code: "event_failed",
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      ),
    )
  })
}

const authorized = (request: Request): boolean => {
  const header = request.headers.get("authorization")
  if (header === `Bearer ${configuration.token}`) {
    return true
  }
  return new URL(request.url).searchParams.get("token") === configuration.token
}

const api = async (request: Request, url: URL): Promise<Response | undefined> => {
  if (url.pathname === "/api/health") {
    return json({ ok: true, version })
  }
  if (!url.pathname.startsWith("/api/")) {
    return undefined
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders })
  }
  if (!authorized(request)) {
    return json({ error: "Unauthorized" }, 401)
  }

  const effect = Effect.gen(function* () {
    const store = yield* RelayStore.Service

    if (request.method === "GET" && url.pathname === "/api/bootstrap") {
      return json(yield* store.bootstrap())
    }
    if (request.method === "GET" && url.pathname === "/api/devices") {
      return json(yield* store.listDevices())
    }
    if (request.method === "POST" && url.pathname === "/api/threads") {
      const input = yield* body(request, decodeCreateThreadInput)
      const thread = yield* store.createThread(input)
      hub.broadcast(SocketEvent.make({ _tag: "ThreadChanged", thread }))
      return json(thread, 201)
    }

    const messageMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/messages$/)
    if (request.method === "POST" && messageMatch?.[1] !== undefined) {
      const threadId = yield* pathId(ThreadId, messageMatch[1])
      const input = yield* body(request, decodeCreateMessageInput)
      const message = yield* store.createMessage(threadId, input)
      hub.broadcast(SocketEvent.make({ _tag: "MessageCreated", message }))
      return json(message, 201)
    }

    if (request.method === "POST" && url.pathname === "/api/tasks") {
      const input = yield* body(request, decodeCreateTaskInput)
      const task = yield* createTask(input)
      const assigned = yield* Effect.tryPromise({
        try: () => dispatch(task),
        catch: (cause) =>
          new RequestError({
            status: 500,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      })
      return json(assigned, 201)
    }

    const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/)
    if (request.method === "GET" && taskMatch?.[1] !== undefined) {
      const taskId = yield* pathId(TaskId, taskMatch[1])
      return json(yield* store.getTask(taskId))
    }

    const cancelMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/)
    if (request.method === "POST" && cancelMatch?.[1] !== undefined) {
      const taskId = yield* pathId(TaskId, cancelMatch[1])
      const current = yield* store.getTask(taskId)
      hub.sendToDevice(current.targetDeviceId, SocketEvent.make({ _tag: "CancelTask", taskId }))
      const task = yield* store.updateTask(taskId, {
        status: "cancelled",
        completedAt: now(),
      })
      broadcastTask(task)
      return json(task)
    }

    const offlineMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/offline$/)
    if (request.method === "POST" && offlineMatch?.[1] !== undefined) {
      const deviceId = yield* pathId(DeviceId, offlineMatch[1])
      const device = yield* store.markDeviceOffline(deviceId)
      hub.broadcast(SocketEvent.make({ _tag: "DeviceChanged", device }))
      return json(device)
    }

    return yield* Effect.fail(new RequestError({ status: 404, message: "Route not found" }))
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof RequestError
        ? cause
        : new RequestError({
            status: 500,
            message:
              typeof cause === "object" &&
              cause !== null &&
              "message" in cause &&
              typeof cause.message === "string"
                ? cause.message
                : String(cause),
          }),
    ),
  )

  return run(effect).catch((cause: unknown) => {
    if (cause instanceof RequestError) {
      return json({ error: cause.message }, cause.status)
    }
    return json(
      {
        error: "Relay request failed",
        detail: cause instanceof Error ? cause.message : String(cause),
      },
      500,
    )
  })
}

const staticResponse = async (request: Request, url: URL): Promise<Response> => {
  const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1)
  const root = normalize(configuration.webDirectory)
  const candidate = normalize(join(root, requested))
  if (relative(root, candidate).startsWith("..")) {
    return new Response("Not found", { status: 404 })
  }
  const file = Bun.file(candidate)
  if (await file.exists()) {
    return new Response(file)
  }
  const index = Bun.file(join(root, "index.html"))
  if (await index.exists()) {
    return new Response(index)
  }
  return json({
    name: "Cohall relay",
    status: "running",
    detail: "Build apps/web to serve the Cohall interface from this process.",
  })
}

const server = Bun.serve<ConnectionData>({
  hostname: configuration.host,
  port: configuration.port,
  async fetch(request, server) {
    const url = new URL(request.url)
    if (url.pathname === "/ws") {
      if (!authorized(request)) {
        return json({ error: "Unauthorized" }, 401)
      }
      const role = url.searchParams.get("role")
      if (role !== "client" && role !== "device") {
        return json({ error: "WebSocket role must be client or device" }, 400)
      }
      if (server.upgrade(request, { data: { role } })) {
        return undefined
      }
      return json({ error: "WebSocket upgrade failed" }, 400)
    }
    const response = await api(request, url)
    return response ?? staticResponse(request, url)
  },
  websocket: {
    open(socket) {
      hub.attach(socket)
      socket.send(
        JSON.stringify(
          SocketEvent.make({ _tag: "Connected", serverVersion: version, connectedAt: now() }),
        ),
      )
    },
    message(socket, message) {
      void handleSocketEvent(socket, message)
    },
    close(socket) {
      const deviceId = hub.detach(socket)
      if (deviceId === undefined) {
        return
      }
      void run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          const tasks = yield* store.requeueTasksFor(deviceId)
          for (const task of tasks) {
            broadcastTask(task)
          }
          const device = yield* store.markDeviceOffline(deviceId)
          hub.broadcast(SocketEvent.make({ _tag: "DeviceChanged", device }))
        }),
      )
    },
  },
})

console.log(`Cohall relay listening on http://${server.hostname}:${server.port}`)

const shutdown = async (): Promise<void> => {
  server.stop(true)
  await runtime.dispose()
  process.exit(0)
}

process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())
