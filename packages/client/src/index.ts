import {
  AuthSession,
  CreatePairingInput,
  CreateTaskInput,
  CreateUpgradeOperationsInput,
  Device,
  DevicePage,
  DeviceOverview,
  DeviceOperation,
  ErrorResponse,
  ExchangePairingInput,
  PairingCredential,
  PairingResult,
  Task,
  TaskProgress,
  TaskClarification,
  type RequestTaskInput,
  type AnswerTaskInput,
  type TaskProgressInput,
  TaskAttachment,
  maxAttachmentBytes,
  maxDevicePageResponseBytes,
  TaskInbox,
  TaskInboxItem,
  TaskTrace,
  ThreadContext,
  UsageSummary,
  type AuthSessionId,
  type AttachmentDirection,
  type AttachmentName as AttachmentNameType,
  type DeviceId,
  type OperationId,
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
  readonly deviceOverview: () => Effect.Effect<ReadonlyArray<DeviceOverview>, RelayClientError>
  readonly verifyDeviceCredential: () => Effect.Effect<void, RelayClientError>
  readonly forgetDevice: (deviceId: DeviceId) => Effect.Effect<Device, RelayClientError>
  readonly createTask: (input: CreateTaskInput) => Effect.Effect<Task, RelayClientError>
  readonly getTask: (taskId: TaskId) => Effect.Effect<Task, RelayClientError>
  readonly reportTaskProgress: (
    taskId: TaskId,
    input: TaskProgressInput,
  ) => Effect.Effect<TaskProgress, RelayClientError>
  readonly requestTaskInput: (
    taskId: TaskId,
    input: RequestTaskInput,
  ) => Effect.Effect<TaskClarification, RelayClientError>
  readonly answerTaskInput: (
    taskId: TaskId,
    input: AnswerTaskInput,
  ) => Effect.Effect<Task, RelayClientError>
  readonly listAttachments: (
    taskId: TaskId,
  ) => Effect.Effect<ReadonlyArray<TaskAttachment>, RelayClientError>
  readonly readAttachment: (
    taskId: TaskId,
    name: AttachmentNameType,
    direction?: AttachmentDirection,
  ) => Effect.Effect<Uint8Array, RelayClientError>
  readonly inbox: () => Effect.Effect<TaskInbox, RelayClientError>
  readonly acknowledgeCompletion: (taskId: TaskId) => Effect.Effect<TaskInboxItem, RelayClientError>
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
  readonly usage: () => Effect.Effect<UsageSummary, RelayClientError>
  readonly createUpgradeOperations: (
    input: CreateUpgradeOperationsInput,
  ) => Effect.Effect<ReadonlyArray<DeviceOperation>, RelayClientError>
  readonly operations: () => Effect.Effect<ReadonlyArray<DeviceOperation>, RelayClientError>
  readonly abandonOperation: (
    operationId: OperationId,
  ) => Effect.Effect<DeviceOperation, RelayClientError>
}

export class Service extends Context.Service<Service, Interface>()("@cohall/RelayClient") {}

const normalizeBaseUrl = (url: string): string => url.replace(/\/+$/, "")

const compareDevices = (left: Device, right: Device): number => {
  // SQLite NOCASE folds ASCII only; match the legacy device-list order.
  const fold = (name: string) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
  const byName = Buffer.compare(Buffer.from(fold(left.name)), Buffer.from(fold(right.name)))
  return byName || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
}

const maxJsonResponseBytes = 2 * 1024 * 1024
const maxTraceResponseBytes = 4 * 1024 * 1024

const jsonBody = async (
  response: Response,
  operation: string,
  maxBytes = maxJsonResponseBytes,
): Promise<unknown> => {
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
    if (size > maxBytes) {
      await reader.cancel()
      throw new RelayDecodeError({
        operation,
        message: `Relay response exceeded ${maxBytes / (1024 * 1024)} MiB`,
      })
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
    maxResponseBytes = maxJsonResponseBytes,
  ): Effect.Effect<S["Type"], RelayClientError> =>
    Effect.gen(function* () {
      const json = yield* Effect.tryPromise({
        try: async (signal) => {
          const response = await fetch(`${baseUrl}${path}`, {
            ...init,
            signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
            headers: {
              authorization: `Bearer ${options.token}`,
              "content-type": "application/json",
              ...init?.headers,
            },
          })
          if (!response.ok) {
            throw new RelayRequestError({
              operation,
              message: await responseMessage(response, operation),
              status: response.status,
            })
          }
          return jsonBody(response, operation, maxResponseBytes).catch((cause: unknown) => {
            throw cause instanceof RelayDecodeError
              ? cause
              : new RelayDecodeError({ operation, message: String(cause) })
          })
        },
        catch: (cause) =>
          cause instanceof RelayRequestError || cause instanceof RelayDecodeError
            ? cause
            : new RelayRequestError({
                operation,
                message: cause instanceof Error ? cause.message : String(cause),
              }),
      })
      return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError((cause) => new RelayDecodeError({ operation, message: String(cause) })),
      )
    })

  const devicePage = (after?: DeviceId) =>
    request(
      "RelayClient.devices",
      `/api/devices/page${after === undefined ? "" : `?after=${encodeURIComponent(after)}`}`,
      DevicePage,
      undefined,
      maxDevicePageResponseBytes,
    )

  return Service.of({
    deviceOverview: () =>
      request(
        "RelayClient.deviceOverview",
        "/api/devices/overview",
        Schema.Array(DeviceOverview),
      ).pipe(
        Effect.mapError((cause) =>
          cause instanceof RelayRequestError && cause.status === 404
            ? new RelayRequestError({
                ...cause,
                message:
                  "This relay does not support the live device view; upgrade the relay first",
              })
            : cause,
        ),
      ),
    verifyDeviceCredential: () =>
      request(
        "RelayClient.verifyDeviceCredential",
        "/api/device/credential",
        Schema.Struct({ ok: Schema.Literal(true) }),
      ).pipe(Effect.asVoid),
    devices: () =>
      Effect.gen(function* () {
        const first = yield* devicePage().pipe(
          Effect.catch((cause) =>
            cause instanceof RelayRequestError && cause.status === 404
              ? request("RelayClient.devices", "/api/devices", Schema.Array(Device))
              : Effect.fail(cause),
          ),
        )
        if (!("devices" in first)) return first
        const devices = [...first.devices]
        let cursor = first.nextCursor
        while (cursor !== undefined) {
          const page = yield* devicePage(cursor)
          const next = page.devices[0]
          if (next === undefined) break
          if (next.id <= cursor)
            return yield* new RelayDecodeError({
              operation: "RelayClient.devices",
              message: "Relay device page did not advance",
            })
          devices.push(...page.devices)
          cursor = page.nextCursor
        }
        return devices.sort(compareDevices)
      }),
    forgetDevice: (deviceId) =>
      request(
        "RelayClient.forgetDevice",
        `/api/devices/${encodeURIComponent(deviceId)}/forget`,
        Device,
        { method: "POST" },
      ),
    createTask: (input) =>
      Effect.gen(function* () {
        const hasAttachments = (input.attachments?.length ?? 0) > 0
        if (input.requestId !== undefined || input.expiresAt !== undefined || hasAttachments) {
          const health = yield* request(
            "RelayClient.taskSupport",
            "/api/health",
            Schema.Struct({
              taskIdempotency: Schema.optionalKey(Schema.Boolean),
              taskDeadlines: Schema.optionalKey(Schema.Boolean),
              taskAttachments: Schema.optionalKey(Schema.Boolean),
            }),
          )
          if (input.requestId !== undefined && health.taskIdempotency !== true) {
            return yield* new RelayRequestError({
              operation: "RelayClient.createTask",
              message: "Upgrade the Cohall relay before using task request IDs",
            })
          }
          if (input.expiresAt !== undefined && health.taskDeadlines !== true)
            return yield* new RelayRequestError({
              operation: "RelayClient.createTask",
              message: "Upgrade the Cohall relay before using task deadlines",
            })
          if (hasAttachments && health.taskAttachments !== true) {
            return yield* new RelayRequestError({
              operation: "RelayClient.createTask",
              message: "Upgrade the Cohall relay before sending file attachments",
            })
          }
        }
        return yield* request("RelayClient.createTask", "/api/tasks", Task, {
          method: "POST",
          body: JSON.stringify(input),
        })
      }),
    requestTaskInput: (taskId, input) =>
      Effect.gen(function* () {
        const health = yield* request(
          "RelayClient.clarificationSupport",
          "/api/health",
          Schema.Struct({ taskClarification: Schema.optionalKey(Schema.Boolean) }),
        )
        if (health.taskClarification !== true)
          return yield* new RelayRequestError({
            operation: "RelayClient.requestTaskInput",
            message: "Upgrade the Cohall relay before requesting clarification",
          })
        return yield* request(
          "RelayClient.requestTaskInput",
          `/api/tasks/${encodeURIComponent(taskId)}/input`,
          TaskClarification,
          { method: "POST", body: JSON.stringify(input) },
        )
      }),
    answerTaskInput: (taskId, input) =>
      request(
        "RelayClient.answerTaskInput",
        `/api/tasks/${encodeURIComponent(taskId)}/answer`,
        Task,
        { method: "POST", body: JSON.stringify(input) },
      ),
    getTask: (taskId) =>
      request("RelayClient.getTask", `/api/tasks/${encodeURIComponent(taskId)}`, Task),
    reportTaskProgress: (taskId, input) =>
      Effect.gen(function* () {
        const health = yield* request(
          "RelayClient.progressSupport",
          "/api/health",
          Schema.Struct({ taskProgress: Schema.optionalKey(Schema.Boolean) }),
        )
        if (health.taskProgress !== true) {
          return yield* new RelayRequestError({
            operation: "RelayClient.reportTaskProgress",
            message: "Upgrade the Cohall relay before reporting task progress",
          })
        }
        return yield* request(
          "RelayClient.reportTaskProgress",
          `/api/tasks/${encodeURIComponent(taskId)}/progress`,
          TaskProgress,
          { method: "POST", body: JSON.stringify(input) },
        )
      }),
    listAttachments: (taskId) =>
      request(
        "RelayClient.listAttachments",
        `/api/tasks/${encodeURIComponent(taskId)}/attachments`,
        Schema.Array(TaskAttachment),
      ),
    readAttachment: (taskId, name, direction) =>
      Effect.tryPromise({
        try: async (signal) => {
          const operation = "RelayClient.readAttachment"
          const response = await fetch(
            `${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(name)}${direction === undefined ? "" : `?direction=${direction}`}`,
            {
              headers: { authorization: `Bearer ${options.token}` },
              signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
            },
          )
          if (!response.ok) {
            throw new RelayRequestError({
              operation,
              message: await responseMessage(response, operation),
              status: response.status,
            })
          }
          if (response.body === null) {
            throw new RelayDecodeError({
              operation,
              message: "Relay returned an empty attachment response",
            })
          }
          const reader = response.body.getReader()
          const chunks: Array<Uint8Array> = []
          let size = 0
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) break
            size += chunk.value.byteLength
            if (size > maxAttachmentBytes) {
              await reader.cancel()
              throw new RelayDecodeError({ operation, message: "Attachment exceeded 256 KiB" })
            }
            chunks.push(chunk.value)
          }
          const bytes = new Uint8Array(size)
          let offset = 0
          for (const chunk of chunks) {
            bytes.set(chunk, offset)
            offset += chunk.byteLength
          }
          return bytes
        },
        catch: (cause) =>
          cause instanceof RelayRequestError || cause instanceof RelayDecodeError
            ? cause
            : new RelayRequestError({
                operation: "RelayClient.readAttachment",
                message: cause instanceof Error ? cause.message : String(cause),
              }),
      }),
    inbox: () => request("RelayClient.inbox", "/api/inbox", TaskInbox),
    acknowledgeCompletion: (taskId) =>
      request(
        "RelayClient.acknowledgeCompletion",
        `/api/inbox/${encodeURIComponent(taskId)}/ack`,
        TaskInboxItem,
        { method: "POST" },
      ),
    traceTask: (taskId) =>
      request(
        "RelayClient.traceTask",
        `/api/tasks/${encodeURIComponent(taskId)}/trace`,
        TaskTrace,
        undefined,
        maxTraceResponseBytes,
      ),
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
    usage: () => request("RelayClient.usage", "/api/usage", UsageSummary),
    createUpgradeOperations: (input) =>
      request(
        "RelayClient.createUpgradeOperations",
        "/api/operations/upgrades",
        Schema.Array(DeviceOperation),
        { method: "POST", body: JSON.stringify(input) },
      ),
    operations: () =>
      request("RelayClient.operations", "/api/operations", Schema.Array(DeviceOperation)),
    abandonOperation: (operationId) =>
      request(
        "RelayClient.abandonOperation",
        `/api/operations/${encodeURIComponent(operationId)}/abandon`,
        DeviceOperation,
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
    const json = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(`${normalizeBaseUrl(baseUrl)}/api/auth/pair`, {
          method: "POST",
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        })
        if (!response.ok) {
          throw new RelayRequestError({
            operation,
            message: await responseMessage(response, operation),
            status: response.status,
          })
        }
        return jsonBody(response, operation).catch((cause: unknown) => {
          throw cause instanceof RelayDecodeError
            ? cause
            : new RelayDecodeError({ operation, message: String(cause) })
        })
      },
      catch: (cause) =>
        cause instanceof RelayRequestError || cause instanceof RelayDecodeError
          ? cause
          : new RelayRequestError({
              operation,
              message: cause instanceof Error ? cause.message : String(cause),
            }),
    })
    return yield* Schema.decodeUnknownEffect(PairingResult)(json).pipe(
      Effect.mapError((cause) => new RelayDecodeError({ operation, message: String(cause) })),
    )
  })

export const layer = (options: RelayClientOptions) => Layer.succeed(Service, make(options))
export * as RelayClient from "./index.ts"
