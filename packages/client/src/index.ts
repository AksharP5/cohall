import {
  Bootstrap,
  CreateMessageInput,
  CreateTaskInput,
  CreateThreadInput,
  Device,
  ErrorResponse,
  Message,
  Task,
  Thread,
  type DeviceId,
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
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export type RelayClientError = RelayRequestError | RelayDecodeError

export interface Interface {
  readonly bootstrap: () => Effect.Effect<Bootstrap, RelayClientError>
  readonly devices: () => Effect.Effect<ReadonlyArray<Device>, RelayClientError>
  readonly createThread: (
    input: CreateThreadInput,
  ) => Effect.Effect<Thread, RelayClientError>
  readonly createMessage: (
    threadId: ThreadId,
    input: CreateMessageInput,
  ) => Effect.Effect<Message, RelayClientError>
  readonly createTask: (input: CreateTaskInput) => Effect.Effect<Task, RelayClientError>
  readonly getTask: (taskId: TaskId) => Effect.Effect<Task, RelayClientError>
  readonly cancelTask: (taskId: TaskId) => Effect.Effect<Task, RelayClientError>
  readonly markDeviceOffline: (deviceId: DeviceId) => Effect.Effect<Device, RelayClientError>
}

export class Service extends Context.Service<Service, Interface>()("@cohall/RelayClient") {}

const normalizeBaseUrl = (url: string): string => url.replace(/\/+$/, "")

const responseMessage = async (response: Response): Promise<string> => {
  const json = await response.json().catch(() => null)
  const decoded = Schema.decodeUnknownOption(ErrorResponse)(json)
  if (decoded._tag === "Some") {
    return decoded.value.detail ?? decoded.value.error
  }
  return `${response.status} ${response.statusText}`.trim()
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
            signal,
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
        const message = yield* Effect.promise(() => responseMessage(response))
        return yield* Effect.fail(
          new RelayRequestError({
            operation,
            message,
            status: response.status,
          }),
        )
      }

      const json = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: (cause) =>
          new RelayDecodeError({
            operation,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      })

      return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError(
          (cause) =>
            new RelayDecodeError({
              operation,
              message: String(cause),
            }),
        ),
      )
    })

  const bootstrap = Effect.fn("RelayClient.bootstrap")(function* () {
    return yield* request("RelayClient.bootstrap", "/api/bootstrap", Bootstrap)
  })

  const devices = Effect.fn("RelayClient.devices")(function* () {
    return yield* request(
      "RelayClient.devices",
      "/api/devices",
      Schema.Array(Device),
    )
  })

  const createThread = Effect.fn("RelayClient.createThread")(function* (
    input: CreateThreadInput,
  ) {
    return yield* request("RelayClient.createThread", "/api/threads", Thread, {
      method: "POST",
      body: JSON.stringify(input),
    })
  })

  const createMessage = Effect.fn("RelayClient.createMessage")(function* (
    threadId: ThreadId,
    input: CreateMessageInput,
  ) {
    return yield* request(
      "RelayClient.createMessage",
      `/api/threads/${encodeURIComponent(threadId)}/messages`,
      Message,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    )
  })

  const createTask = Effect.fn("RelayClient.createTask")(function* (input: CreateTaskInput) {
    return yield* request("RelayClient.createTask", "/api/tasks", Task, {
      method: "POST",
      body: JSON.stringify(input),
    })
  })

  const getTask = Effect.fn("RelayClient.getTask")(function* (taskId: TaskId) {
    return yield* request(
      "RelayClient.getTask",
      `/api/tasks/${encodeURIComponent(taskId)}`,
      Task,
    )
  })

  const cancelTask = Effect.fn("RelayClient.cancelTask")(function* (taskId: TaskId) {
    return yield* request(
      "RelayClient.cancelTask",
      `/api/tasks/${encodeURIComponent(taskId)}/cancel`,
      Task,
      { method: "POST" },
    )
  })

  const markDeviceOffline = Effect.fn("RelayClient.markDeviceOffline")(function* (
    deviceId: DeviceId,
  ) {
    return yield* request(
      "RelayClient.markDeviceOffline",
      `/api/devices/${encodeURIComponent(deviceId)}/offline`,
      Device,
      { method: "POST" },
    )
  })

  return Service.of({
    bootstrap,
    devices,
    createThread,
    createMessage,
    createTask,
    getTask,
    cancelTask,
    markDeviceOffline,
  })
}

export const layer = (options: RelayClientOptions) => Layer.succeed(Service, make(options))

export * as RelayClient from "./index.ts"
