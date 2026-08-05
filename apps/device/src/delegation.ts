import type { Interface as RelayClient } from "@cohall/client"
import {
  DeviceId,
  Provider,
  TaskId,
  TaskStatus,
  ThreadId,
  isTerminalTask,
  type Device,
  type Provider as ProviderName,
  type Task,
  type ThreadId as ThreadIdType,
} from "@cohall/protocol"
import { Effect, Schema } from "effect"
import type { ClientConfiguration } from "./config.ts"

export class DeviceSelectionError extends Schema.TaggedErrorClass<DeviceSelectionError>()(
  "Cohall.DeviceSelectionError",
  { message: Schema.String, devices: Schema.Array(Schema.String) },
) {}

export class TaskWaitTimeoutError extends Schema.TaggedErrorClass<TaskWaitTimeoutError>()(
  "Cohall.TaskWaitTimeoutError",
  { message: Schema.String, taskId: TaskId, status: TaskStatus },
) {}

export interface DelegateOptions {
  readonly prompt: string
  readonly target?: string
  readonly context?: string
  readonly threadId?: ThreadIdType
  readonly workspace?: string
  readonly provider?: ProviderName
}

export const TaskResult = Schema.Struct({
  task_id: TaskId,
  thread_id: ThreadId,
  status: TaskStatus,
  provider: Provider,
  target_device_id: DeviceId,
  result: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
})
export interface TaskResult extends Schema.Schema.Type<typeof TaskResult> {}

const matchingDevices = (devices: ReadonlyArray<Device>, target: string): ReadonlyArray<Device> => {
  const normalized = target.replace(/^@/, "").toLowerCase()
  const byId = devices.find((device) => device.id === target)
  return byId === undefined
    ? devices.filter(
        (device) =>
          device.name.toLowerCase() === normalized || device.hostname.toLowerCase() === normalized,
      )
    : [byId]
}

export const taskResult = (task: Task): TaskResult =>
  TaskResult.make({
    task_id: task.id,
    thread_id: task.threadId,
    status: task.status,
    provider: task.provider,
    target_device_id: task.targetDeviceId,
    ...(task.result === undefined ? {} : { result: task.result }),
    ...(task.error === undefined ? {} : { error: task.error }),
  })

export const createDelegation = Effect.fn("Cohall.createDelegation")(function* (
  client: RelayClient,
  configuration: ClientConfiguration,
  options: DelegateOptions,
) {
  const devices = yield* client.devices()
  const matches = options.target === undefined ? [] : matchingDevices(devices, options.target)
  if (options.target !== undefined && matches.length !== 1) {
    return yield* new DeviceSelectionError({
      message:
        matches.length === 0
          ? `No Cohall device matches ${options.target}`
          : `${options.target} is ambiguous; use a device ID`,
      devices:
        matches.length === 0
          ? devices.map((device) => `${device.name} (${device.id})`)
          : matches.map((device) => `${device.name} (${device.id})`),
    })
  }
  if (devices.length === 0) {
    return yield* new DeviceSelectionError({
      message: "No Cohall devices are registered",
      devices: [],
    })
  }
  const target = matches[0]
  const inheritedThread = configuration.mcpThreadId
  return yield* client.createTask({
    prompt: options.prompt,
    ...(target === undefined ? {} : { targetDeviceId: target.id }),
    ...(options.threadId !== undefined
      ? { threadId: options.threadId }
      : inheritedThread === undefined
        ? {}
        : { threadId: ThreadId.make(inheritedThread) }),
    ...(options.context === undefined ? {} : { context: options.context }),
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    ...(options.provider === undefined ? {} : { provider: options.provider }),
  })
})

export const waitForTask = Effect.fn("Cohall.waitForTask")(function* (
  client: RelayClient,
  initial: Task,
  timeoutSeconds: number,
) {
  const deadline = Date.now() + timeoutSeconds * 1_000
  let task = initial
  while (!isTerminalTask(task)) {
    if (Date.now() >= deadline) {
      return yield* new TaskWaitTimeoutError({
        message: `Task ${task.id} is still ${task.status} after ${timeoutSeconds} seconds`,
        taskId: task.id,
        status: task.status,
      })
    }
    yield* Effect.sleep("1 second")
    task = yield* client.getTask(task.id)
  }
  return task
})

export const threadContext = Effect.fn("Cohall.threadContext")(function* (
  client: RelayClient,
  threadId: ThreadIdType,
) {
  return yield* client.threadContext(threadId)
})
