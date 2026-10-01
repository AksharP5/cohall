import { RelayRequestError, type Interface as RelayClient } from "@cohall/client"
import {
  BotId,
  DeviceId,
  Provider,
  TaskId,
  TaskStatus,
  TaskProgress,
  TaskClarification,
  TaskRunId,
  TaskDeadline,
  type Timestamp,
  TaskRequestId,
  type RequestTaskInput,
  ThreadId,
  terminalTaskStatuses,
  isTerminalTask,
  type Device,
  type InputAttachment,
  type Provider as ProviderName,
  type Task,
  type TaskTrace,
  type ThreadId as ThreadIdType,
} from "@cohall/protocol"
import { Effect, Schedule, Schema } from "effect"
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
  readonly requestId?: TaskRequestId
  readonly prompt: string
  readonly target?: string
  readonly context?: string
  readonly threadId?: ThreadIdType
  readonly workspace?: string
  readonly provider?: ProviderName
  readonly parentTaskId?: TaskId
  readonly attachments?: ReadonlyArray<InputAttachment>
  readonly expiresAt?: Timestamp
}

export const TaskResult = Schema.Struct({
  task_id: TaskId,
  thread_id: ThreadId,
  status: TaskStatus,
  provider: Provider,
  target_device_id: DeviceId,
  bot_id: Schema.optionalKey(BotId),
  result: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  inbox_warning: Schema.optionalKey(Schema.String),
  progress: Schema.optionalKey(TaskProgress),
  input_request: Schema.optionalKey(TaskClarification),
  expires_at: Schema.optionalKey(TaskDeadline),
})
export interface TaskResult extends Schema.Schema.Type<typeof TaskResult> {}

const matchingDevices = (devices: ReadonlyArray<Device>, target: string): ReadonlyArray<Device> => {
  const value = target.replace(/^@/, "")
  const normalized = value.toLowerCase()
  const byId = devices.find((device) => device.id === value)
  return byId === undefined
    ? devices.filter(
        (device) =>
          device.name.toLowerCase() === normalized || device.hostname.toLowerCase() === normalized,
      )
    : [byId]
}

export const listBots = (devices: ReadonlyArray<Device>) =>
  devices.flatMap((device) =>
    (device.bots ?? []).map((bot) => ({
      id: bot.id,
      name: bot.name,
      ...(bot.description === undefined ? {} : { description: bot.description }),
      device_id: device.id,
      device_name: device.name,
      status: device.status,
      target: `@${device.id}/${bot.id}`,
    })),
  )

const selectTarget = Effect.fn("Cohall.selectTarget")(function* (
  devices: ReadonlyArray<Device>,
  target: string,
) {
  const value = target.replace(/^@/, "")
  const separator = value.indexOf("/")
  const qualified = separator !== -1
  const deviceMatches = matchingDevices(devices, qualified ? value.slice(0, separator) : value)
  const botValue = qualified ? value.slice(separator + 1) : value
  const bots = listBots(qualified ? deviceMatches : devices)
  const botsById = bots.filter((bot) => bot.id === botValue)
  const botMatches =
    botsById.length > 0
      ? botsById
      : bots.filter((bot) => bot.name.toLowerCase() === botValue.toLowerCase())
  // An exact device ID remains a direct device target, even if a bot uses it as a name.
  const exactDevice = qualified ? undefined : deviceMatches.find((device) => device.id === value)
  if (exactDevice !== undefined) return { deviceId: exactDevice.id, botId: undefined }
  const matches = [
    ...(qualified
      ? []
      : deviceMatches.map((device) => ({ deviceId: device.id, botId: undefined }))),
    ...botMatches.map((bot) => ({ deviceId: bot.device_id, botId: bot.id })),
  ]
  const selected = matches[0]
  if (matches.length === 1 && selected !== undefined) return selected
  return yield* new DeviceSelectionError({
    message:
      matches.length === 0
        ? `No Cohall device or bot matches ${target}; use cohall devices or cohall bots`
        : `${target} is ambiguous; use a device ID or @device-id/bot-id from cohall bots`,
    devices: [
      ...deviceMatches.map((device) => `${device.name} (@${device.id})`),
      ...botMatches.map((bot) => `${bot.name} on ${bot.device_name} (${bot.target})`),
    ],
  })
})

export const taskResult = (task: Task): TaskResult => {
  const question = task.clarifications?.at(-1)
  return TaskResult.make({
    task_id: task.id,
    thread_id: task.threadId,
    status: task.status,
    provider: task.provider,
    target_device_id: task.targetDeviceId,
    ...(task.botId === undefined ? {} : { bot_id: task.botId }),
    ...(task.result === undefined ? {} : { result: task.result }),
    ...(task.error === undefined ? {} : { error: task.error }),
    ...(task.expiresAt === undefined ? {} : { expires_at: task.expiresAt }),
    ...(task.progress === undefined ? {} : { progress: task.progress }),
    ...(task.status === "needs_input" && question !== undefined ? { input_request: question } : {}),
  })
}

export const acknowledgedTaskResult = async (
  client: RelayClient,
  task: Task,
  signal?: AbortSignal,
): Promise<TaskResult> => {
  signal?.throwIfAborted()
  const result = taskResult(task)
  if (!isTerminalTask(task)) return result
  const acknowledgementError = await Effect.runPromise(client.acknowledgeCompletion(task.id), {
    signal,
  })
    .then(() => undefined)
    .catch((cause: unknown) => {
      signal?.throwIfAborted()
      if (cause instanceof RelayRequestError && cause.status === 404) return undefined
      return cause instanceof Error ? cause.message : String(cause)
    })
  return acknowledgementError === undefined
    ? result
    : TaskResult.make({
        ...result,
        inbox_warning: `Result received, but the inbox could not be cleared: ${acknowledgementError}`,
      })
}

export const requestInput = Effect.fn("Cohall.requestInput")(function* (
  client: RelayClient,
  configuration: ClientConfiguration,
  question: RequestTaskInput["question"],
  taskId?: TaskId,
  runId?: TaskRunId,
) {
  const id =
    taskId ??
    (configuration.mcpTaskId === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(TaskId)(configuration.mcpTaskId))
  if (id === undefined)
    return yield* new RelayRequestError({
      operation: "Cohall.requestInput",
      message: "Task id is required outside delegated work",
    })
  const inheritedRun = id === configuration.mcpTaskId ? configuration.mcpTaskRunId : undefined
  const turn = runId ?? inheritedRun ?? (yield* client.getTask(id)).runId
  if (turn === undefined)
    return yield* new RelayRequestError({
      operation: "Cohall.requestInput",
      message: "Task has no current worker turn; upgrade the relay and worker",
    })
  return yield* client.requestTaskInput(id, { runId: turn, question })
})

export const createDelegation = Effect.fn("Cohall.createDelegation")(function* (
  client: RelayClient,
  configuration: ClientConfiguration,
  options: DelegateOptions,
) {
  if (
    options.requestId !== undefined &&
    options.threadId !== undefined &&
    options.target === undefined &&
    options.provider === undefined &&
    options.parentTaskId === undefined &&
    configuration.mcpTaskId === undefined
  )
    return yield* new DeviceSelectionError({
      message: "With a request ID, select a target or provider explicitly for thread follow-ups",
      devices: [],
    })
  const directTarget = (() => {
    if (options.requestId === undefined || options.target === undefined) return undefined
    const value = options.target.replace(/^@/, "")
    const separator = value.indexOf("/")
    const id = Schema.decodeUnknownOption(DeviceId)(
      separator < 0 ? value : value.slice(0, separator),
    )
    if (id._tag === "None") return undefined
    return {
      deviceId: id.value,
      botId:
        separator < 0 ? undefined : Schema.decodeUnknownSync(BotId)(value.slice(separator + 1)),
    }
  })()
  const needsDiscovery =
    directTarget === undefined && (options.requestId === undefined || options.target !== undefined)
  const devices = needsDiscovery ? yield* client.devices() : []
  if (needsDiscovery && devices.length === 0) {
    return yield* new DeviceSelectionError({
      message: "No Cohall devices are registered",
      devices: [],
    })
  }
  let target =
    directTarget ??
    (options.target === undefined ? undefined : yield* selectTarget(devices, options.target))
  if (
    target === undefined &&
    options.requestId === undefined &&
    options.threadId !== undefined &&
    options.provider === undefined &&
    options.parentTaskId === undefined &&
    configuration.mcpTaskId === undefined
  ) {
    const context = yield* client.threadContext(options.threadId)
    const previous = context.tasks.findLast((task) => task.parentTaskId === undefined)
    if (previous === undefined && context.truncated) {
      return yield* new DeviceSelectionError({
        message: "Earlier thread targets are no longer in the retained context; specify --target",
        devices: [],
      })
    }
    if (previous?.provider === "grok-bot" && previous.botId !== undefined) {
      target = yield* selectTarget(devices, `@${previous.targetDeviceId}/${previous.botId}`)
    }
  }
  const botId = target?.botId
  if (botId !== undefined && options.provider !== undefined && options.provider !== "grok-bot") {
    return yield* new DeviceSelectionError({
      message: `A bot target requires provider grok-bot, not ${options.provider}`,
      devices: [],
    })
  }
  if (botId === undefined && options.provider === "grok-bot") {
    return yield* new DeviceSelectionError({
      message: "Select a bot with --target; use cohall bots to list available bots",
      devices: [],
    })
  }
  const provider = botId === undefined ? options.provider : "grok-bot"
  const inheritedThread = configuration.mcpThreadId
  const parentTaskId =
    options.parentTaskId ??
    (configuration.mcpTaskId === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(TaskId)(configuration.mcpTaskId))
  return yield* client.createTask({
    prompt: options.prompt,
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    ...(target === undefined ? {} : { targetDeviceId: target.deviceId }),
    ...(botId === undefined ? {} : { botId }),
    ...(options.threadId !== undefined
      ? { threadId: options.threadId }
      : inheritedThread === undefined
        ? {}
        : { threadId: ThreadId.make(inheritedThread) }),
    ...(options.context === undefined ? {} : { context: options.context }),
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    ...(provider === undefined ? {} : { provider }),
    ...(parentTaskId === undefined ? {} : { parentTaskId }),
    ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
  })
})

export const waitForTask = Effect.fn("Cohall.waitForTask")(function* (
  client: RelayClient,
  initial: Task,
  timeoutSeconds: number,
) {
  const deadline = Date.now() + timeoutSeconds * 1_000
  let task = initial
  while (!isTerminalTask(task) && task.status !== "needs_input") {
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

export const followTaskTrace = Effect.fn("Cohall.followTaskTrace")(function* (
  client: RelayClient,
  taskId: TaskId,
  onTrace: (trace: TaskTrace) => void,
) {
  let revision: string | undefined
  const poll = client.traceTask(taskId).pipe(
    Effect.tap((trace) => {
      const latest = trace.events.at(-1)
      const nextRevision = `${trace.status}:${latest?.kind ?? "none"}:${latest?.at ?? "none"}:${trace.progress?.at ?? ""}:${trace.progress?.note ?? ""}:${JSON.stringify(trace.clarifications)}`
      if (nextRevision === revision) {
        return Effect.succeed(undefined)
      }
      revision = nextRevision
      return Effect.sync(() => onTrace(trace))
    }),
  )
  return yield* poll.pipe(
    Effect.repeat({
      until: (trace) => terminalTaskStatuses.has(trace.status),
      schedule: Schedule.spaced("1 second"),
    }),
  )
})

export const threadContext = Effect.fn("Cohall.threadContext")(function* (
  client: RelayClient,
  threadId: ThreadIdType,
) {
  return yield* client.threadContext(threadId)
})
