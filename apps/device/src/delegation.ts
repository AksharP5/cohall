import type { Interface as RelayClient } from "@cohall/client"
import {
  DeviceId,
  TaskId,
  TaskStatus,
  ThreadId,
  isTerminalTask,
  type Device,
  type Task,
  type ThreadId as ThreadIdType,
} from "@cohall/protocol"
import { Effect, Schedule, Schema } from "effect"
import type { DeviceConfiguration } from "./config.ts"

export class DeviceSelectionError extends Schema.TaggedErrorClass<DeviceSelectionError>()(
  "Cohall.DeviceSelectionError",
  {
    message: Schema.String,
    devices: Schema.Array(Schema.String),
  },
) {}

export interface DelegateOptions {
  readonly prompt: string
  readonly target?: string
  readonly context?: string
  readonly threadId?: ThreadIdType
  readonly workspace?: string
}

export const TaskResult = Schema.Struct({
  task_id: TaskId,
  thread_id: ThreadId,
  status: TaskStatus,
  target_device_id: DeviceId,
  result: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
})
export interface TaskResult extends Schema.Schema.Type<typeof TaskResult> {}

export const resolveDevice = (
  devices: ReadonlyArray<Device>,
  target: string,
): Device | undefined => {
  const normalized = target.replace(/^@/, "").toLowerCase()
  return devices.find(
    (device) =>
      device.id === target ||
      device.name.toLowerCase() === normalized ||
      device.hostname.toLowerCase() === normalized,
  )
}

export const taskResult = (task: Task): TaskResult =>
  TaskResult.make({
    task_id: task.id,
    thread_id: task.threadId,
    status: task.status,
    target_device_id: task.targetDeviceId,
    ...(task.result === undefined ? {} : { result: task.result }),
    ...(task.error === undefined ? {} : { error: task.error }),
  })

export const createDelegation = Effect.fn("Cohall.createDelegation")(function* (
  client: RelayClient,
  configuration: DeviceConfiguration,
  options: DelegateOptions,
) {
  const devices = yield* client.devices()
  const device = options.target === undefined ? undefined : resolveDevice(devices, options.target)

  if (devices.length === 0 || (options.target !== undefined && device === undefined)) {
    return yield* new DeviceSelectionError({
      message:
        devices.length === 0
          ? "No Cohall devices are registered"
          : `No Cohall device matches ${options.target}`,
      devices: devices.map((known) => known.name),
    })
  }

  return yield* client.createTask({
    prompt: options.prompt,
    ...(devices.some((known) => known.id === configuration.id)
      ? { sourceDeviceId: configuration.id }
      : {}),
    ...(device === undefined ? {} : { targetDeviceId: DeviceId.make(device.id) }),
    ...(options.threadId === undefined
      ? configuration.mcpThreadId === undefined
        ? {}
        : { threadId: ThreadId.make(configuration.mcpThreadId) }
      : { threadId: options.threadId }),
    ...(options.context === undefined ? {} : { context: options.context }),
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
  })
})

export const waitForTask = Effect.fn("Cohall.waitForTask")(function* (
  client: RelayClient,
  task: Task,
  timeoutSeconds: number,
) {
  if (isTerminalTask(task)) {
    return task
  }

  return yield* client.getTask(task.id).pipe(
    Effect.repeat({
      until: isTerminalTask,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.timeout(`${timeoutSeconds} seconds`),
  )
})

export const threadContext = Effect.fn("Cohall.threadContext")(function* (
  client: RelayClient,
  threadId: ThreadIdType,
) {
  const bootstrap = yield* client.bootstrap()
  return {
    thread: bootstrap.threads.find((thread) => thread.id === threadId),
    messages: bootstrap.messages.filter((message) => message.threadId === threadId),
    tasks: bootstrap.tasks.filter((task) => task.threadId === threadId),
  }
})
