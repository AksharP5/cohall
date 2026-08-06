import {
  AuthSession,
  CreatePairingInput,
  CreateTaskInput,
  Device,
  ErrorResponse,
  ExchangePairingInput,
  PairingCredential,
  PairingResult,
  Task,
  TaskTrace,
  ThreadContext,
  type AuthSessionId,
  type TaskId,
  type ThreadId,
} from "@cohall/protocol"
import { Context, Effect, Layer, Schema } from "effect"

export interface RelayClientOptions {
  readonly baseUrl: string
  readonly token: string
}

export class RelayRequestError extends Schema.TaggedErrorClass<RelayRequestError>()(
  "RelayClient.RequestError",
  {
    operation: Schema.String,
    message: Schema.String,
    status: Schema.optionalKey(Schema.Number),
  },
) {}

export class RelayDecodeError extends Schema.TaggedErrorClass<RelayDecodeError>()(
  "RelayClient.DecodeError",
  { operation: Schema.String, message: Schema.String },
) {}

export type RelayClientError = RelayRequestError | RelayDecodeError

export interface Interface {
  readonly devices: () => Effect.Effect<ReadonlyArray<Device>, RelayClientError>
  readonly createTask: (input: CreateTaskInput) => Effect.Effect<Task, RelayClientError>
  readonly getTask: (taskId: TaskId) => Effect.Effect<Task, RelayClientError>
  readonly traceTask: (taskId: TaskId) => Effect.Effect<TaskTrace, RelayClientError>
  readonly cancelTask: (taskId: TaskId) => Effect.Effect<Task, RelayClientError>
  readonly threadContext: (threadId: ThreadId) => Effect.Effect<ThreadContext, RelayClientError>
  readonly createPairing: (
    input: CreatePairingInput,
  ) => Effect.Effect<PairingCredential, RelayClientError>
  readonly authSessions: () => Effect.Effect<ReadonlyArray<AuthSession>, RelayClientError>
  readonly revokeAuthSession: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<AuthSession, RelayClientError>
}

export class Service extends Context.Service<Service, Interface>()("@cohall/RelayClient") {}

const normalizeBaseUrl = (url: string): string => url.replace(/\/+$/, "")

const jsonBody = async (response: Response, operation: string): Promise<unknown> => {
  if (response.body === null) {
    throw new RelayDecodeError({ operation, message: "Relay returned an empty response" })
  }
  const reader = response.body.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) {
      break
    }
    size += chunk.value.byteLength
    if (size > 2 * 1024 * 1024) {
      await reader.cancel()
      throw new RelayDecodeError({ operation, message: "Relay response exceeded 2 MiB" })
    }
    chunks.push(chunk.value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const text = new TextDecoder().decode(bytes)
  try {
    return JSON.parse(text) as unknown
  } catch (cause) {
    throw new RelayDecodeError({
      operation,
      message: cause instanceof Error ? cause.message : String(cause),
    })
  }
}

const responseMessage = async (response: Response, operation: string): Promise<string> => {
  const json = await jsonBody(response, operation).catch(() => undefined)
  const decoded = Schema.decodeUnknownOption(ErrorResponse)(json)
  return decoded._tag === "Some"
    ? decoded.value.error
    : `${response.status} ${response.statusText}`.trim()
}

export const make = (options: RelayClientOptions): Interface => {
  const baseUrl = normalizeBaseUrl(options.baseUrl)

  const request = <S extends Schema.Top & { readonly DecodingServices: never }>(
    operation: string,
    path: string,
    schema: S,
    init?: RequestInit,
  ): Effect.Effect<S["Type"], RelayClientError> =>
    Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(`${baseUrl}${path}`, {
            ...init,
            signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
            headers: {
              authorization: `Bearer ${options.token}`,
              "content-type": "application/json",
              ...init?.headers,
            },
          }),
        catch: (cause) =>
          new RelayRequestError({
            operation,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      })
      if (!response.ok) {
        return yield* Effect.fail(
          new RelayRequestError({
            operation,
            message: yield* Effect.promise(() => responseMessage(response, operation)),
            status: response.status,
          }),
        )
      }
      const json = yield* Effect.tryPromise({
        try: () => jsonBody(response, operation),
        catch: (cause) =>
          cause instanceof RelayDecodeError
            ? cause
            : new RelayDecodeError({ operation, message: String(cause) }),
      })
      return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError((cause) => new RelayDecodeError({ operation, message: String(cause) })),
      )
    })

  return Service.of({
    devices: () => request("RelayClient.devices", "/api/devices", Schema.Array(Device)),
    createTask: (input) =>
      request("RelayClient.createTask", "/api/tasks", Task, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    getTask: (taskId) =>
      request("RelayClient.getTask", `/api/tasks/${encodeURIComponent(taskId)}`, Task),
    traceTask: (taskId) =>
      request("RelayClient.traceTask", `/api/tasks/${encodeURIComponent(taskId)}/trace`, TaskTrace),
    cancelTask: (taskId) =>
      request("RelayClient.cancelTask", `/api/tasks/${encodeURIComponent(taskId)}/cancel`, Task, {
        method: "POST",
      }),
    threadContext: (threadId) =>
      request(
        "RelayClient.threadContext",
        `/api/threads/${encodeURIComponent(threadId)}`,
        ThreadContext,
      ),
    createPairing: (input) =>
      request("RelayClient.createPairing", "/api/auth/pairings", PairingCredential, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    authSessions: () =>
      request("RelayClient.authSessions", "/api/auth/sessions", Schema.Array(AuthSession)),
    revokeAuthSession: (sessionId) =>
      request(
        "RelayClient.revokeAuthSession",
        `/api/auth/sessions/${encodeURIComponent(sessionId)}/revoke`,
        AuthSession,
        { method: "POST" },
      ),
  })
}

export const exchangePairing = (
  baseUrl: string,
  input: ExchangePairingInput,
): Effect.Effect<PairingResult, RelayClientError> =>
  Effect.gen(function* () {
    const operation = "RelayClient.exchangePairing"
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`${normalizeBaseUrl(baseUrl)}/api/auth/pair`, {
          method: "POST",
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
      catch: (cause) =>
        new RelayRequestError({
          operation,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    })
    if (!response.ok) {
      return yield* Effect.fail(
        new RelayRequestError({
          operation,
          message: yield* Effect.promise(() => responseMessage(response, operation)),
          status: response.status,
        }),
      )
    }
    const json = yield* Effect.tryPromise({
      try: () => jsonBody(response, operation),
      catch: (cause) =>
        cause instanceof RelayDecodeError
          ? cause
          : new RelayDecodeError({ operation, message: String(cause) }),
    })
    return yield* Schema.decodeUnknownEffect(PairingResult)(json).pipe(
      Effect.mapError((cause) => new RelayDecodeError({ operation, message: String(cause) })),
    )
  })

export const layer = (options: RelayClientOptions) => Layer.succeed(Service, make(options))
export * as RelayClient from "./index.ts"
