import {
  AuthSessionId,
  Device,
  DeviceId,
  SocketEvent,
  maxSocketPayloadBytes,
  TaskId,
  ThreadId,
  decodeCreatePairingInput,
  decodeCreateTaskInput,
  decodeExchangePairingInput,
  decodeSocketEvent,
  now,
  version,
  type AuthSession,
  type CreateTaskInput,
  type DeviceId as DeviceIdType,
  type Task,
} from "@cohall/protocol"
import { Effect, ManagedRuntime, Schema } from "effect"
import { createHash, timingSafeEqual } from "node:crypto"
import { access, chmod } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { ListenOptions } from "node:net"
import { platform } from "node:os"
import { WebSocketServer, type RawData } from "ws"
import { loadEnvironmentConfiguration, type RelayConfiguration } from "./config.ts"
import { Hub, type ConnectionSocket } from "./hub.ts"
import { RelayStore } from "./store.ts"

type RelayListenOptions = ListenOptions | { readonly fd: number }

class RequestError extends Schema.TaggedErrorClass<RequestError>()("Relay.RequestError", {
  status: Schema.Int,
  message: Schema.String,
}) {}

export const relayListenOptions = (
  configuration: Pick<RelayConfiguration, "host" | "port">,
  environment: NodeJS.ProcessEnv = process.env,
  pid = process.pid,
): RelayListenOptions => {
  const listenPid = Number(environment.LISTEN_PID)
  const listenFds = Number(environment.LISTEN_FDS)
  if (listenPid !== pid || !Number.isInteger(listenFds) || listenFds < 1) {
    return { host: configuration.host, port: configuration.port }
  }

  const descriptorNames = environment.LISTEN_FDNAMES?.split(":") ?? []
  const namedIndex = descriptorNames.indexOf("cohall-relay")
  if (namedIndex >= 0 && namedIndex < listenFds) {
    return { fd: 3 + namedIndex }
  }
  if (listenFds === 1) {
    return { fd: 3 }
  }
  throw new Error("Cohall received multiple systemd sockets but none was named cohall-relay")
}

const json = (value: unknown, status = 200): Response =>
  Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  })

const requestBody = (request: IncomingMessage, limit: number): Promise<Buffer | undefined> => {
  if (request.method === "GET" || request.method === "HEAD") {
    return Promise.resolve(undefined)
  }
  return new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = []
    let size = 0
    const cleanup = (): void => {
      request.off("data", onData)
      request.off("end", onEnd)
      request.off("error", onError)
    }
    const onData = (chunk: Buffer): void => {
      size += chunk.byteLength
      if (size <= limit) {
        chunks.push(chunk)
        return
      }
      cleanup()
      reject(new Error("Request body exceeded 256 KiB"))
    }
    const onEnd = (): void => {
      cleanup()
      resolve(Buffer.concat(chunks, size))
    }
    const onError = (cause: Error): void => {
      cleanup()
      reject(cause)
    }
    request.on("data", onData)
    request.once("end", onEnd)
    request.once("error", onError)
  })
}

const webRequest = async (request: IncomingMessage): Promise<Request> => {
  const headers = new Headers()
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]
    const value = request.rawHeaders[index + 1]
    if (name !== undefined && value !== undefined) {
      headers.append(name, value)
    }
  }
  const payload = await requestBody(request, 256 * 1024)
  return new Request(new URL(request.url ?? "/", "http://cohall.local"), {
    method: request.method ?? "GET",
    headers,
    ...(payload === undefined ? {} : { body: new Uint8Array(payload) }),
  })
}

const sendResponse = async (target: ServerResponse, response: Response): Promise<void> => {
  target.statusCode = response.status
  response.headers.forEach((value, name) => target.setHeader(name, value))
  target.end(Buffer.from(await response.arrayBuffer()))
}

const socketText = (message: RawData): string => {
  if (Buffer.isBuffer(message)) {
    return message.toString("utf8")
  }
  if (message instanceof ArrayBuffer) {
    return Buffer.from(message).toString("utf8")
  }
  if (Array.isArray(message)) {
    return Buffer.concat(message).toString("utf8")
  }
  return Buffer.from(message).toString("utf8")
}

const rejectUpgrade = (socket: NodeJS.WritableStream, status: number, message: string): void => {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  if ("destroy" in socket && typeof socket.destroy === "function") {
    socket.destroy()
  }
}

const body = <A, E, R>(
  request: Request,
  decode: (input: unknown) => Effect.Effect<A, E, R>,
): Effect.Effect<A, RequestError, R> =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => new RequestError({ status: 400, message: "Expected a JSON request body" }),
  }).pipe(
    Effect.flatMap(decode),
    Effect.mapError((cause) =>
      cause instanceof RequestError
        ? cause
        : new RequestError({ status: 400, message: String(cause).slice(0, 2_048) }),
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

const scoreDevice = (
  device: Device,
  input: CreateTaskInput,
  sourceDeviceId: DeviceIdType | undefined,
): number => {
  const prompt = `${input.prompt} ${input.context ?? ""}`.toLowerCase()
  const needsXcode = /\b(xcode|ios|macos|swiftui|app store)\b/.test(prompt)
  const needsBrowser =
    /\b(browser|chrome|youtube|twitter|logged[- ]?in|signed[- ]?in|x\.com)\b/.test(prompt)
  return (
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
    (sourceDeviceId === device.id ? -5 : 0)
  )
}

const chooseDevice = (
  input: CreateTaskInput,
  sourceDeviceId?: DeviceIdType,
): Effect.Effect<DeviceIdType, RequestError, RelayStore.Service> =>
  Effect.gen(function* () {
    const store = yield* RelayStore.Service
    const devices = yield* store
      .listDevices()
      .pipe(Effect.mapError((cause) => new RequestError({ status: 500, message: cause.message })))
    const provider = input.provider ?? "codex"
    if (input.targetDeviceId !== undefined) {
      const target = devices.find((device) => device.id === input.targetDeviceId)
      if (target === undefined) {
        return yield* new RequestError({
          status: 404,
          message: `Unknown target device ${input.targetDeviceId}`,
        })
      }
      if (!target.providers.includes(provider)) {
        return yield* new RequestError({
          status: 409,
          message: `${target.name} does not advertise the ${provider} provider`,
        })
      }
      return target.id
    }
    const selected = devices
      .filter((device) => device.providers.includes(provider))
      .sort(
        (left, right) =>
          scoreDevice(right, input, sourceDeviceId) - scoreDevice(left, input, sourceDeviceId),
      )[0]
    if (selected === undefined) {
      return yield* new RequestError({
        status: 409,
        message: `No Cohall device advertises the ${provider} provider`,
      })
    }
    return selected.id
  })

type Principal = "owner" | AuthSession

export const runRelay = async (): Promise<void> => {
  const configuration = await Effect.runPromise(loadEnvironmentConfiguration)
  process.umask(0o077)
  const runtime = ManagedRuntime.make(
    RelayStore.layer(configuration.databasePath, configuration.historyTaskLimit),
  )
  const run = <A, E>(effect: Effect.Effect<A, E, RelayStore.Service>): Promise<A> =>
    runtime.runPromise(effect)
  await run(
    Effect.gen(function* () {
      const store = yield* RelayStore.Service
      yield* store.recover()
    }),
  )
  if (
    platform() !== "win32" &&
    (await access(configuration.databasePath)
      .then(() => true)
      .catch(() => false))
  ) {
    await chmod(configuration.databasePath, 0o600)
  }

  const hub = new Hub()
  let connections = 0

  const tokenDigest = (token: string): Buffer => createHash("sha256").update(token).digest()
  const ownerToken = (token: string): boolean =>
    timingSafeEqual(tokenDigest(token), tokenDigest(configuration.token))

  const authenticate = async (
    token: string,
    role: "client" | "device",
  ): Promise<Principal | undefined> => {
    if (ownerToken(token)) {
      return "owner"
    }
    return run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        return yield* store.authenticateSession(token, role)
      }),
    ).catch(() => undefined)
  }

  const principalFor = async (request: Request): Promise<Principal | undefined> => {
    const authorization = request.headers.get("authorization")
    if (authorization?.startsWith("Bearer ") !== true) {
      return undefined
    }
    return authenticate(authorization.slice("Bearer ".length), "client")
  }

  const dispatch = async (task: Task): Promise<Task> => {
    const assigned = await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        return yield* store.assignTask(task.id)
      }),
    )
    if (assigned.status !== "assigned") {
      return assigned
    }
    if (
      hub.sendToDevice(
        assigned.targetDeviceId,
        SocketEvent.make({ _tag: "TaskAssigned", task: assigned }),
      )
    ) {
      return assigned
    }
    return run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        return yield* store.rollbackAssignment(task.id)
      }),
    )
  }

  const dispatchPending = async (deviceId: DeviceIdType): Promise<void> => {
    const tasks = await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        return yield* store.pendingTasksFor(deviceId)
      }),
    )
    for (const task of tasks) {
      if (task.status === "cancelling") {
        hub.sendToDevice(deviceId, SocketEvent.make({ _tag: "CancelTask", taskId: task.id }))
      } else {
        await dispatch(task)
      }
    }
  }

  const sendError = (socket: ConnectionSocket, code: string, message: string): void => {
    socket.send(
      JSON.stringify(
        SocketEvent.make({
          _tag: "Error",
          code: code.slice(0, 64),
          message: message.slice(0, 2_048),
        }),
      ),
    )
  }

  const handleSocketEvent = async (socket: ConnectionSocket, input: RawData): Promise<void> => {
    const event = await Effect.runPromise(
      Effect.try({
        try: () => JSON.parse(socketText(input)) as unknown,
        catch: () => new RequestError({ status: 400, message: "Invalid socket JSON" }),
      }).pipe(Effect.flatMap(decodeSocketEvent)),
    ).catch((cause: unknown) => {
      sendError(socket, "invalid_event", cause instanceof Error ? cause.message : String(cause))
      return undefined
    })
    if (event === undefined) {
      return
    }

    if (!hub.isAuthorized(socket)) {
      if (event._tag !== "Authenticate") {
        socket.close(4003, "Authentication required")
        return
      }
      const principal = await authenticate(event.token, "device")
      if (principal === undefined) {
        socket.close(4003, "Authentication failed")
        return
      }
      if (hub.pendingConnections() >= 64) {
        socket.close(4008, "Pending device connection limit reached")
        return
      }
      const attached = hub.attach(socket, {
        ...(principal === "owner" ? {} : { sessionId: principal.id }),
        ...(principal === "owner" || principal.deviceId === undefined
          ? {}
          : { boundDeviceId: principal.deviceId }),
        ...(principal === "owner" ? {} : { expiresAt: principal.expiresAt }),
      })
      if (!attached) {
        socket.close(4008, "Credential connection limit reached")
        return
      }
      socket.data.stageDeadline = setTimeout(() => {
        if (hub.deviceId(socket) === undefined) {
          socket.close(4003, "Device registration timeout")
        }
      }, 5_000)
      socket.send(
        JSON.stringify(
          SocketEvent.make({ _tag: "Connected", serverVersion: version, connectedAt: now() }),
        ),
      )
      return
    }

    if (event._tag === "Authenticate") {
      return
    }
    if (event._tag === "DeviceHello") {
      const bound = hub.boundDeviceId(socket)
      if (bound !== undefined && bound !== event.device.id) {
        socket.close(4003, "Device identity does not match its session")
        return
      }
      const device = Device.make({
        ...event.device,
        status: "online",
        connectedAt: now(),
        lastSeenAt: now(),
      })
      if (!hub.registerDevice(device.id, socket)) {
        socket.close(4009, "Device is already connected")
        return
      }
      await run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          yield* store.upsertDevice(device)
        }),
      )
      await dispatchPending(device.id)
      return
    }

    const deviceId = hub.deviceId(socket)
    if (deviceId === undefined) {
      sendError(socket, "device_hello_required", "Send DeviceHello before device events")
      return
    }

    const settle = (taskId: TaskId): void => {
      socket.send(JSON.stringify(SocketEvent.make({ _tag: "TaskSettled", taskId })))
    }
    const processed = await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        switch (event._tag) {
          case "DeviceHeartbeat":
            if (event.deviceId === deviceId) {
              yield* store.heartbeat(deviceId, event.status === "busy" ? "busy" : "online")
            }
            return
          case "TaskAccepted":
            yield* store.acceptTask(event.taskId, deviceId)
            return
          case "TaskFinished":
            yield* store.finishTask(event.taskId, deviceId, event.result, event.providerSessionId)
            return
          case "TaskFailed":
            yield* store.failTask(event.taskId, deviceId, event.error)
            return
          case "TaskCancelled":
            yield* store.acknowledgeCancellation(event.taskId, deviceId)
            return
          case "Connected":
          case "TaskAssigned":
          case "TaskSettled":
          case "CancelTask":
          case "Error":
            return
        }
      }),
    )
      .then(() => true)
      .catch((cause: unknown) => {
        sendError(socket, "event_failed", cause instanceof Error ? cause.message : String(cause))
        return false
      })
    if (
      processed &&
      (event._tag === "TaskFinished" ||
        event._tag === "TaskFailed" ||
        event._tag === "TaskCancelled")
    ) {
      settle(event.taskId)
      await dispatchPending(deviceId)
    }
  }

  const api = async (request: Request, url: URL): Promise<Response> => {
    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true, version })
    }
    if (url.pathname === "/api/auth/pair" && request.method === "POST") {
      return run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          const input = yield* body(request, decodeExchangePairingInput)
          return yield* store.exchangePairing(input.token)
        }),
      )
        .then((value) => json(value, 201))
        .catch(() =>
          json({ error: "Pairing credential is invalid, expired, or already used" }, 401),
        )
    }

    const principal = await principalFor(request)
    if (principal === undefined) {
      return json({ error: "Unauthorized" }, 401)
    }
    const ownerOnly = url.pathname.startsWith("/api/auth/")
    if (ownerOnly && principal !== "owner") {
      return json({ error: "Owner token required" }, 403)
    }
    const sourceDeviceId = principal === "owner" ? undefined : principal.deviceId

    const effect = Effect.gen(function* () {
      const store = yield* RelayStore.Service
      if (url.pathname === "/api/auth/pairings" && request.method === "POST") {
        const input = yield* body(request, decodeCreatePairingInput)
        return json(yield* store.createPairing(input), 201)
      }
      if (url.pathname === "/api/auth/sessions" && request.method === "GET") {
        return json(yield* store.listAuthSessions())
      }
      const revoke = url.pathname.match(/^\/api\/auth\/sessions\/([^/]+)\/revoke$/)
      if (request.method === "POST" && revoke?.[1] !== undefined) {
        const id = yield* pathId(AuthSessionId, revoke[1])
        const session = yield* store.revokeAuthSession(id)
        hub.closeSession(id)
        return json(session)
      }
      if (url.pathname === "/api/devices" && request.method === "GET") {
        return json(yield* store.listDevices())
      }
      const forgetDevice = url.pathname.match(/^\/api\/devices\/([^/]+)\/forget$/)
      if (request.method === "POST" && forgetDevice?.[1] !== undefined) {
        if (principal !== "owner") {
          return yield* new RequestError({ status: 403, message: "Owner token required" })
        }
        const id = yield* pathId(DeviceId, forgetDevice[1])
        if (hub.hasDevice(id)) {
          return yield* new RequestError({
            status: 409,
            message: `Device ${id} must be offline before it can be forgotten`,
          })
        }
        const forgotten = yield* store.forgetDevice(id)
        hub.closeDevice(id)
        return json(forgotten)
      }
      if (url.pathname === "/api/tasks" && request.method === "POST") {
        const input = yield* body(request, decodeCreateTaskInput)
        const target = yield* chooseDevice(input, sourceDeviceId)
        const providerSessionId =
          input.threadId === undefined
            ? undefined
            : yield* store.sessionFor(input.threadId, target, input.provider ?? "codex")
        const task = yield* store.createDelegation(input, target, sourceDeviceId, providerSessionId)
        return json(yield* Effect.tryPromise(() => dispatch(task)), 201)
      }
      const task = url.pathname.match(/^\/api\/tasks\/([^/]+)$/)
      if (request.method === "GET" && task?.[1] !== undefined) {
        return json(yield* store.getTask(yield* pathId(TaskId, task[1])))
      }
      const trace = url.pathname.match(/^\/api\/tasks\/([^/]+)\/trace$/)
      if (request.method === "GET" && trace?.[1] !== undefined) {
        return json(yield* store.traceTask(yield* pathId(TaskId, trace[1])))
      }
      const cancel = url.pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/)
      if (request.method === "POST" && cancel?.[1] !== undefined) {
        const id = yield* pathId(TaskId, cancel[1])
        const updated = yield* store.requestCancellation(id)
        if (updated.status === "cancelling") {
          hub.sendToDevice(
            updated.targetDeviceId,
            SocketEvent.make({ _tag: "CancelTask", taskId: id }),
          )
        }
        return json(updated)
      }
      const thread = url.pathname.match(/^\/api\/threads\/([^/]+)$/)
      if (request.method === "GET" && thread?.[1] !== undefined) {
        return json(yield* store.threadContext(yield* pathId(ThreadId, thread[1])))
      }
      return yield* new RequestError({ status: 404, message: "Route not found" })
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof RequestError
          ? cause
          : new RequestError({
              status:
                cause._tag !== "RelayStore.PersistenceError"
                  ? 500
                  : cause.message.startsWith("Unknown")
                    ? 404
                    : cause.message.includes("outstanding task limit")
                      ? 429
                      : cause.message.includes("must be offline") ||
                          cause.message.includes("still has outstanding tasks")
                        ? 409
                        : 500,
              message: cause.message,
            }),
      ),
    )
    return run(effect).catch((cause: unknown) =>
      cause instanceof RequestError
        ? json(
            { error: cause.status === 500 ? "Relay request failed" : cause.message },
            cause.status,
          )
        : json({ error: "Relay request failed" }, 500),
    )
  }

  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: maxSocketPayloadBytes,
    perMessageDeflate: false,
  })
  websocketServer.on("connection", (rawSocket) => {
    const socket = rawSocket as ConnectionSocket
    socket.data = {
      processing: Promise.resolve(),
      stageDeadline: undefined,
      preAuthFrameReceived: false,
      queuedMessages: 0,
      closed: false,
    }
    connections += 1
    socket.data.stageDeadline = setTimeout(() => {
      if (!hub.isAuthorized(socket)) {
        socket.close(4003, "Authentication timeout")
      }
    }, 5_000)
    let alive = true
    socket.on("pong", () => {
      alive = true
    })
    const heartbeat = setInterval(() => {
      if (!hub.isAuthorized(socket)) {
        return
      }
      if (!alive) {
        socket.terminate()
        return
      }
      alive = false
      socket.ping()
    }, 30_000)
    heartbeat.unref()

    socket.on("message", (message: RawData) => {
      if (!hub.isAuthorized(socket)) {
        const size = Buffer.byteLength(socketText(message))
        if (socket.data.preAuthFrameReceived || size > 1_024) {
          socket.close(4003, "Only one authentication frame is allowed")
          return
        }
        socket.data.preAuthFrameReceived = true
        socket.data.processing = handleSocketEvent(socket, message).catch((cause: unknown) => {
          sendError(socket, "event_failed", cause instanceof Error ? cause.message : String(cause))
        })
        return
      }
      if (socket.data.queuedMessages >= 8) {
        socket.close(4008, "Message queue limit reached")
        return
      }
      socket.data.queuedMessages += 1
      socket.data.processing = socket.data.processing
        .then(() => (socket.data.closed ? undefined : handleSocketEvent(socket, message)))
        .catch((cause: unknown) => {
          sendError(socket, "event_failed", cause instanceof Error ? cause.message : String(cause))
        })
        .finally(() => {
          socket.data.queuedMessages = Math.max(0, socket.data.queuedMessages - 1)
        })
    })

    socket.once("close", () => {
      clearInterval(heartbeat)
      socket.data.closed = true
      connections = Math.max(0, connections - 1)
      const deviceId = hub.detach(socket)
      if (deviceId === undefined) {
        return
      }
      void run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          yield* store.requeueTasksFor(deviceId)
          yield* store.markDeviceOffline(deviceId)
        }),
      ).catch((cause: unknown) => console.error(cause))
    })
  })

  const server = createServer((incoming, outgoing) => {
    void webRequest(incoming)
      .then((request) => {
        const url = new URL(request.url)
        return url.pathname.startsWith("/api/")
          ? api(request, url)
          : json({ name: "Cohall relay", version, status: "running" })
      })
      .then((response) => sendResponse(outgoing, response))
      .catch((cause: unknown) =>
        sendResponse(
          outgoing,
          json(
            { error: cause instanceof Error ? cause.message : "Invalid request" },
            cause instanceof Error && cause.message.includes("256 KiB") ? 413 : 400,
          ),
        ),
      )
  })
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://cohall.local")
    if (url.pathname !== "/ws/device") {
      rejectUpgrade(socket, 404, "Not Found")
      return
    }
    if (connections >= 1_024) {
      rejectUpgrade(socket, 503, "Service Unavailable")
      return
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit("connection", websocket, request)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(relayListenOptions(configuration), () => {
      server.off("error", reject)
      resolve()
    })
  })

  const address = server.address()
  const listener =
    typeof address === "string"
      ? address
      : address?.family === "IPv6"
        ? `[${address.address}]:${address.port}`
        : `${address?.address ?? configuration.host}:${address?.port ?? configuration.port}`
  console.log(`Cohall relay listening on http://${listener}`)
  let stopping = false
  const shutdown = async (): Promise<void> => {
    if (stopping) {
      return
    }
    stopping = true
    for (const socket of websocketServer.clients) {
      socket.close(1001, "Relay shutting down")
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
    websocketServer.close()
    await runtime.dispose()
  }
  process.once("SIGINT", () => void shutdown())
  process.once("SIGTERM", () => void shutdown())
}

if (import.meta.main) {
  await runRelay().catch((cause: unknown) => {
    console.error(cause instanceof Error ? cause.message : String(cause))
    process.exitCode = 1
  })
}
