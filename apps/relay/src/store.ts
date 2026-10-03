import {
  AuthSession,
  ConnectionRole,
  Device,
  DevicePage,
  DeviceId,
  DeviceOperation,
  DeviceUsage,
  Message,
  PairingCredential,
  PairingResult,
  Provider,
  Task,
  TaskProgress,
  TaskClarification,
  TaskRunId,
  ClarificationId,
  type RequestTaskInput,
  type AnswerTaskInput,
  type TaskProgressInput,
  TaskAttachment,
  TaskId,
  TaskInbox,
  TaskInboxItem,
  TaskStatus,
  TaskTrace,
  TaskTraceEvent,
  TaskStatusCounts,
  Timestamp,
  Thread,
  ThreadContext,
  UsageSummary,
  assertDeviceOperationSupport,
  makeAuthSessionId,
  makeDeviceId,
  makeMessageId,
  makeOperationId,
  makeTaskId,
  makeThreadId,
  maxAttachmentBytes,
  maxDevicePageDevices,
  maxDevicePageResponseBytes,
  maxTaskAttachments,
  maxTaskClarifications,
  taskDeadlinePassed,
  taskDeadlineError,
  now,
  taskSlot,
  type AuthSessionId,
  type AttachmentDirection,
  type AttachmentName as AttachmentNameType,
  type ConnectionRole as ConnectionRoleName,
  type CreatePairingInput,
  type CreateTaskInput,
  type InputAttachment,
  type CreateUpgradeOperationsInput,
  type OperationId,
  type OperationStatus,
  type TaskTraceEventKind,
  type ThreadId,
} from "@cohall/protocol"
import { Context, Effect, Layer, Schema } from "effect"
import { createHash, randomBytes } from "node:crypto"
import { Database } from "./database.ts"

export class PersistenceError extends Schema.TaggedErrorClass<PersistenceError>()(
  "RelayStore.PersistenceError",
  {
    operation: Schema.String,
    message: Schema.String,
    missingRecord: Schema.optionalKey(Schema.Literals(["task", "operation"])),
  },
) {}

export class TaskProgressError extends Schema.TaggedErrorClass<TaskProgressError>()(
  "RelayStore.TaskProgressError",
  { status: Schema.Literals([403, 409]), message: Schema.String },
) {}

export class TaskInputError extends Schema.TaggedErrorClass<TaskInputError>()(
  "RelayStore.TaskInputError",
  { status: Schema.Literals([403, 409]), message: Schema.String },
) {}

export class TaskDeadlineError extends Schema.TaggedErrorClass<TaskDeadlineError>()(
  "RelayStore.TaskDeadlineError",
  { status: Schema.Literals([400, 409]), message: Schema.String },
) {}

export class TaskRequestError extends Schema.TaggedErrorClass<TaskRequestError>()(
  "RelayStore.TaskRequestError",
  { status: Schema.Literals([409, 410]), message: Schema.String },
) {}

interface ThreadRow {
  readonly id: string
  readonly title: string
  readonly created_at: string
  readonly updated_at: string
  readonly default_device_id: string | null
}

interface MessageRow {
  readonly id: string
  readonly thread_id: string
  readonly role: string
  readonly author_name: string
  readonly content: string
  readonly created_at: string
  readonly task_id: string | null
  readonly device_id: string | null
}

interface DeviceRow {
  readonly id: string
  readonly name: string
  readonly hostname: string
  readonly platform: string
  readonly architecture: string
  readonly status: string
  readonly providers_json: string
  readonly bots_json: string | null
  readonly capabilities_json: string
  readonly workspaces_json: string
  readonly version: string
  readonly last_seen_at: string
  readonly connected_at: string | null
  readonly queued_tasks?: number
  readonly oldest_queued_at?: string | null
}

interface TaskRow {
  readonly id: string
  readonly run_id: string | null
  readonly clarifications_json: string | null
  readonly thread_id: string
  readonly prompt: string
  readonly context: string | null
  readonly provider: string
  readonly bot_id: string | null
  readonly status: string
  readonly source_device_id: string | null
  readonly requester_id: string | null
  readonly completion_seen_at: string | null
  readonly target_device_id: string
  readonly parent_task_id: string | null
  readonly workspace: string | null
  readonly provider_session_id: string | null
  readonly result: string | null
  readonly error: string | null
  readonly created_at: string
  readonly updated_at: string
  readonly started_at: string | null
  readonly completed_at: string | null
  readonly expires_at: string | null
  readonly progress_note: string | null
  readonly progress_at: string | null
}

interface InboxRow {
  readonly id: string
  readonly thread_id: string
  readonly target_device_id: string
  readonly provider: string
  readonly bot_id: string | null
  readonly status: string
  readonly prompt_preview: string
  readonly result_preview: string | null
  readonly error_preview: string | null
  readonly completed_at: string | null
  readonly input_request_json: string | null
}

interface TaskTraceEventRow {
  readonly id: number
  readonly kind: string
  readonly created_at: string
  readonly detail: string | null
}

interface DeviceOperationRow {
  readonly id: string
  readonly kind: string
  readonly status: string
  readonly target_device_id: string
  readonly requested_version: string
  readonly restart: number
  readonly result: string | null
  readonly error: string | null
  readonly created_at: string
  readonly updated_at: string
  readonly completed_at: string | null
}

interface UsageRow {
  readonly device_id: string
  readonly device_name: string
  readonly status: string
  readonly provider: string
  readonly tasks: number
}

interface PairingRow {
  readonly token_hash: string
  readonly label: string
  readonly roles_json: string
  readonly expires_at: string
  readonly used_at: string | null
}

interface AuthSessionRow {
  readonly id: string
  readonly token_hash: string
  readonly label: string
  readonly roles_json: string
  readonly created_at: string
  readonly expires_at: string
  readonly last_seen_at: string
  readonly bound_device_id: string | null
  readonly revoked_at: string | null
}

export interface TaskUpdate {
  readonly status?: TaskStatus
  readonly providerSessionId?: string
  readonly result?: string
  readonly error?: string
  readonly startedAt?: Timestamp
  readonly completedAt?: Timestamp
}

export interface Interface {
  readonly recover: () => Effect.Effect<void, PersistenceError>
  readonly listDevices: () => Effect.Effect<ReadonlyArray<Device>, PersistenceError>
  readonly listDevicePage: (after?: DeviceId) => Effect.Effect<DevicePage, PersistenceError>
  readonly usage: () => Effect.Effect<UsageSummary, PersistenceError>
  readonly forgetDevice: (deviceId: DeviceId) => Effect.Effect<Device, PersistenceError>
  readonly upsertDevice: (device: Device) => Effect.Effect<Device, PersistenceError>
  readonly heartbeat: (
    deviceId: DeviceId,
    status: "online" | "busy",
    bots?: Device["bots"],
  ) => Effect.Effect<Device, PersistenceError>
  readonly markDeviceOffline: (deviceId: DeviceId) => Effect.Effect<Device, PersistenceError>
  readonly createDelegation: (
    input: CreateTaskInput,
    targetDeviceId: DeviceId,
    principal: AuthSession | "owner",
    providerSessionId?: string,
    requestedInput?: CreateTaskInput,
  ) => Effect.Effect<Task, PersistenceError | TaskDeadlineError | TaskRequestError>
  readonly expireTasks: () => Effect.Effect<ReadonlyArray<Task>, PersistenceError>
  readonly findDelegation: (
    input: CreateTaskInput,
    principal: AuthSession | "owner",
  ) => Effect.Effect<Task | undefined, PersistenceError | TaskRequestError>
  readonly inboxFor: (
    principal: AuthSession | "owner",
  ) => Effect.Effect<TaskInbox, PersistenceError>
  readonly acknowledgeCompletion: (
    taskId: TaskId,
    principal: AuthSession | "owner",
  ) => Effect.Effect<TaskInboxItem, PersistenceError>
  readonly getTask: (taskId: TaskId) => Effect.Effect<Task, PersistenceError>
  readonly reportTaskProgress: (
    taskId: TaskId,
    deviceId: DeviceId,
    note: TaskProgressInput["note"],
  ) => Effect.Effect<TaskProgress, PersistenceError | TaskProgressError>
  readonly requestTaskInput: (
    taskId: TaskId,
    deviceId: DeviceId,
    input: RequestTaskInput,
  ) => Effect.Effect<TaskClarification, PersistenceError | TaskInputError>
  readonly answerTaskInput: (
    taskId: TaskId,
    principal: AuthSession | "owner",
    input: AnswerTaskInput,
  ) => Effect.Effect<Task, PersistenceError | TaskInputError>
  readonly listAttachments: (
    taskId: TaskId,
  ) => Effect.Effect<ReadonlyArray<TaskAttachment>, PersistenceError>
  readonly readAttachment: (
    taskId: TaskId,
    name: AttachmentNameType,
    direction?: AttachmentDirection,
  ) => Effect.Effect<Uint8Array, PersistenceError>
  readonly traceTask: (taskId: TaskId) => Effect.Effect<TaskTrace, PersistenceError>
  readonly threadContext: (threadId: ThreadId) => Effect.Effect<ThreadContext, PersistenceError>
  readonly pendingTasksFor: (
    deviceId: DeviceId,
  ) => Effect.Effect<ReadonlyArray<Task>, PersistenceError>
  readonly assignTask: (taskId: TaskId) => Effect.Effect<Task, PersistenceError>
  readonly markTaskDispatched: (taskId: TaskId) => Effect.Effect<void, PersistenceError>
  readonly rollbackAssignment: (taskId: TaskId) => Effect.Effect<Task, PersistenceError>
  readonly acceptTask: (
    taskId: TaskId,
    deviceId: DeviceId,
    runId?: TaskRunId,
  ) => Effect.Effect<Task, PersistenceError>
  readonly finishTask: (
    taskId: TaskId,
    deviceId: DeviceId,
    result: string,
    providerSessionId?: string,
    attachments?: ReadonlyArray<InputAttachment>,
    runId?: TaskRunId,
  ) => Effect.Effect<Task, PersistenceError>
  readonly failTask: (
    taskId: TaskId,
    deviceId: DeviceId,
    error: string,
    runId?: TaskRunId,
  ) => Effect.Effect<Task, PersistenceError>
  readonly acknowledgeCancellation: (
    taskId: TaskId,
    deviceId: DeviceId,
    runId?: TaskRunId,
  ) => Effect.Effect<Task, PersistenceError>
  readonly requestCancellation: (taskId: TaskId) => Effect.Effect<Task, PersistenceError>
  readonly requeueTasksFor: (deviceId: DeviceId) => Effect.Effect<void, PersistenceError>
  readonly createUpgradeOperations: (
    input: CreateUpgradeOperationsInput,
  ) => Effect.Effect<ReadonlyArray<DeviceOperation>, PersistenceError>
  readonly listOperations: () => Effect.Effect<ReadonlyArray<DeviceOperation>, PersistenceError>
  readonly abandonOperation: (
    operationId: OperationId,
  ) => Effect.Effect<DeviceOperation, PersistenceError>
  readonly pendingOperationsFor: (
    deviceId: DeviceId,
  ) => Effect.Effect<ReadonlyArray<DeviceOperation>, PersistenceError>
  readonly assignOperation: (
    operationId: OperationId,
  ) => Effect.Effect<DeviceOperation, PersistenceError>
  readonly rollbackOperation: (
    operationId: OperationId,
  ) => Effect.Effect<DeviceOperation, PersistenceError>
  readonly acceptOperation: (
    operationId: OperationId,
    deviceId: DeviceId,
  ) => Effect.Effect<DeviceOperation, PersistenceError>
  readonly finishOperation: (
    operationId: OperationId,
    deviceId: DeviceId,
    result: string,
  ) => Effect.Effect<DeviceOperation, PersistenceError>
  readonly failOperation: (
    operationId: OperationId,
    deviceId: DeviceId,
    error: string,
  ) => Effect.Effect<DeviceOperation, PersistenceError>
  readonly requeueOperationsFor: (deviceId: DeviceId) => Effect.Effect<void, PersistenceError>
  readonly sessionFor: (
    threadId: ThreadId,
    deviceId: DeviceId,
    provider: Provider,
  ) => Effect.Effect<string | undefined, PersistenceError>
  readonly createPairing: (
    input: CreatePairingInput,
  ) => Effect.Effect<PairingCredential, PersistenceError>
  readonly exchangePairing: (token: string) => Effect.Effect<PairingResult, PersistenceError>
  readonly authenticateSession: (
    token: string,
    role: ConnectionRoleName,
  ) => Effect.Effect<AuthSession | undefined, PersistenceError>
  readonly listAuthSessions: () => Effect.Effect<ReadonlyArray<AuthSession>, PersistenceError>
  readonly revokeAuthSession: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<AuthSession, PersistenceError>
}

export class Service extends Context.Service<Service, Interface>()("@cohall/RelayStore") {}

const operationError =
  (operation: string) =>
  (cause: unknown): PersistenceError =>
    new PersistenceError({
      operation,
      message: cause instanceof Error ? cause.message : String(cause),
    })

const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
  operation: string,
  schema: S,
  value: unknown,
): Effect.Effect<S["Type"], PersistenceError> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(operationError(operation)))

const threadFromRow = (row: ThreadRow): Effect.Effect<Thread, PersistenceError> =>
  decode("RelayStore.decodeThread", Thread, {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.default_device_id === null ? {} : { defaultDeviceId: row.default_device_id }),
  })

const messageFromRow = (row: MessageRow): Effect.Effect<Message, PersistenceError> =>
  decode("RelayStore.decodeMessage", Message, {
    id: row.id,
    threadId: row.thread_id,
    role: row.role === "tool" ? "agent" : row.role,
    authorName: row.author_name,
    content: row.content,
    createdAt: row.created_at,
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    ...(row.device_id === null ? {} : { deviceId: row.device_id }),
  })

const deviceFromRow = (row: DeviceRow): Effect.Effect<Device, PersistenceError> =>
  decode("RelayStore.decodeDevice", Device, {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    platform: row.platform,
    architecture: row.architecture,
    status: row.status,
    providers: JSON.parse(row.providers_json) as unknown,
    ...(row.bots_json === null ? {} : { bots: JSON.parse(row.bots_json) as unknown }),
    capabilities: JSON.parse(row.capabilities_json) as unknown,
    workspaces: JSON.parse(row.workspaces_json) as unknown,
    version: row.version,
    lastSeenAt: row.last_seen_at,
    ...(row.connected_at === null ? {} : { connectedAt: row.connected_at }),
    ...(row.queued_tasks === undefined
      ? {}
      : {
          queue: {
            queued: row.queued_tasks,
            ...(row.oldest_queued_at === undefined || row.oldest_queued_at === null
              ? {}
              : { oldestQueuedAt: row.oldest_queued_at }),
          },
        }),
  })

const taskFromRow = (db: Database, row: TaskRow): Effect.Effect<Task, PersistenceError> =>
  Effect.try({
    try: () =>
      db
        .query<{ readonly name: string }, [string]>(
          "SELECT name FROM task_attachments WHERE task_id = ? AND direction = 'input' ORDER BY name",
        )
        .all(row.id),
    catch: operationError("RelayStore.taskAttachments"),
  }).pipe(
    Effect.flatMap((attachments) =>
      decode("RelayStore.decodeTask", Task, {
        id: row.id,
        ...(row.run_id === null ? {} : { runId: row.run_id }),
        ...(row.clarifications_json === null
          ? {}
          : { clarifications: JSON.parse(row.clarifications_json) as unknown }),
        threadId: row.thread_id,
        prompt: row.prompt,
        provider: row.provider,
        ...(row.bot_id === null ? {} : { botId: row.bot_id }),
        status: row.status,
        targetDeviceId: row.target_device_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
        ...(row.context === null ? {} : { context: row.context }),
        ...(row.source_device_id === null ? {} : { sourceDeviceId: row.source_device_id }),
        ...(row.parent_task_id === null ? {} : { parentTaskId: row.parent_task_id }),
        ...(row.workspace === null ? {} : { workspace: row.workspace }),
        ...(row.provider_session_id === null ? {} : { providerSessionId: row.provider_session_id }),
        ...(row.result === null ? {} : { result: row.result }),
        ...(attachments.length === 0
          ? {}
          : { inputAttachmentNames: attachments.map((item) => item.name) }),
        ...(row.error === null ? {} : { error: row.error }),
        ...(row.progress_note === null
          ? {}
          : { progress: { note: row.progress_note, at: row.progress_at } }),
        ...(row.started_at === null ? {} : { startedAt: row.started_at }),
        ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
      }),
    ),
  )

const inboxItemFromRow = (row: InboxRow): Effect.Effect<TaskInboxItem, PersistenceError> =>
  decode("RelayStore.decodeInboxItem", TaskInboxItem, {
    id: row.id,
    threadId: row.thread_id,
    targetDeviceId: row.target_device_id,
    provider: row.provider,
    ...(row.bot_id === null ? {} : { botId: row.bot_id }),
    status: row.status,
    promptPreview: row.prompt_preview,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.input_request_json === null
      ? {}
      : { inputRequest: JSON.parse(row.input_request_json) as unknown }),
    ...(row.result_preview === null ? {} : { resultPreview: row.result_preview }),
    ...(row.error_preview === null ? {} : { errorPreview: row.error_preview }),
  })

const operationFromRow = (
  row: DeviceOperationRow,
): Effect.Effect<DeviceOperation, PersistenceError> =>
  decode("RelayStore.decodeOperation", DeviceOperation, {
    id: row.id,
    kind: row.kind,
    status: row.status,
    targetDeviceId: row.target_device_id,
    requestedVersion: row.requested_version,
    restart: row.restart === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.result === null ? {} : { result: row.result }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  })

const emptyStatusCounts = (): Record<TaskStatus, number> => ({
  queued: 0,
  assigned: 0,
  running: 0,
  needs_input: 0,
  cancelling: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
})

const taskTraceEventFromRow = (
  row: TaskTraceEventRow,
): Effect.Effect<TaskTraceEvent, PersistenceError> =>
  decode("RelayStore.decodeTaskTraceEvent", TaskTraceEvent, {
    kind: row.kind,
    at: row.created_at,
    ...(row.detail === null ? {} : { detail: row.detail }),
  })

const rolesFromRow = (row: AuthSessionRow): ReadonlyArray<ConnectionRoleName> =>
  Schema.decodeUnknownSync(Schema.Array(ConnectionRole))(JSON.parse(row.roles_json))

const authSessionFromRow = (row: AuthSessionRow): Effect.Effect<AuthSession, PersistenceError> => {
  const roles = rolesFromRow(row)
  const role = roles[0]
  return role === undefined
    ? Effect.fail(
        new PersistenceError({
          operation: "RelayStore.decodeAuthSession",
          message: `Session ${row.id} has no role`,
        }),
      )
    : decode("RelayStore.decodeAuthSession", AuthSession, {
        id: row.id,
        label: row.label,
        role,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        lastSeenAt: row.last_seen_at,
        ...(row.bound_device_id === null ? {} : { deviceId: row.bound_device_id }),
        ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
      })
}

const secret = (prefix: "pair" | "session"): string => {
  return `cohall_${prefix}_${randomBytes(32).toString("hex")}`
}
const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex")

const providerName = (provider: Provider): string => {
  switch (provider) {
    case "codex":
      return "Codex"
    case "claude-code":
      return "Claude Code"
    case "opencode":
      return "OpenCode"
    case "grok-bot":
      return "Grok Bot"
  }
}

const recentWithin = <A>(items: ReadonlyArray<A>, byteBudget: number) => {
  const encoder = new TextEncoder()
  const selected: Array<A> = []
  let bytes = 0
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item === undefined) {
      continue
    }
    const itemBytes = encoder.encode(JSON.stringify(item)).byteLength
    if (bytes + itemBytes > byteBudget) {
      break
    }
    bytes += itemBytes
    selected.unshift(item)
  }
  return { items: selected, truncated: selected.length < items.length }
}

const derivedTraceEvents = (task: Task): ReadonlyArray<TaskTraceEvent> => {
  const detail = "Derived from task timestamps; earlier trace events were not recorded"
  const events: Array<TaskTraceEvent> = [
    TaskTraceEvent.make({ kind: "queued", at: task.createdAt, detail }),
  ]
  if (task.startedAt !== undefined) {
    events.push(TaskTraceEvent.make({ kind: "running", at: task.startedAt, detail }))
  } else if (task.status === "assigned") {
    events.push(TaskTraceEvent.make({ kind: "assigned", at: task.updatedAt, detail }))
  }
  if (task.status === "cancelling") {
    events.push(TaskTraceEvent.make({ kind: "cancelling", at: task.updatedAt, detail }))
  }
  if (
    task.completedAt !== undefined &&
    (task.status === "completed" || task.status === "failed" || task.status === "cancelled")
  ) {
    events.push(TaskTraceEvent.make({ kind: task.status, at: task.completedAt, detail }))
  }
  return events
}

const interruptedTaskStatus = `CASE
  WHEN json_array_length(clarifications_json) > 0
    AND json_extract(clarifications_json, '$[#-1].answer') IS NULL THEN 'needs_input'
  ELSE 'queued' END`

const makeService = (db: Database, retainedTerminalTasks = 1_000): Interface => {
  const requestHash = (input: CreateTaskInput): string => {
    const { requestId: _requestId, attachments, ...fields } = input
    const normalized = {
      ...fields,
      provider: input.provider ?? (input.botId === undefined ? "codex" : "grok-bot"),
      ...(attachments === undefined || attachments.length === 0
        ? {}
        : {
            attachments: attachments.map(({ name, data }) => [
              name,
              Buffer.from(data, "base64").toString("base64"),
            ]),
          }),
    }
    return createHash("sha256")
      .update(
        JSON.stringify(
          Object.entries(normalized).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        ),
      )
      .digest("hex")
  }

  const requestedTask = (
    input: CreateTaskInput,
    principal: AuthSession | "owner",
  ): TaskRow | null => {
    if (input.requestId === undefined) return null
    const saved = db
      .query<{ readonly input_hash: string; readonly task_id: string | null }, [string, string]>(
        "SELECT input_hash, task_id FROM task_requests WHERE requester_id = ? AND request_id = ?",
      )
      .get(principal === "owner" ? "owner" : principal.id, input.requestId.toLowerCase())
    if (saved === null) return null
    if (saved.input_hash !== requestHash(input))
      throw new TaskRequestError({
        status: 409,
        message: "Request ID was already used with different task input",
      })
    if (saved.task_id === null)
      throw new TaskRequestError({
        status: 410,
        message: "The original task is no longer retained; this request ID cannot be reused",
      })
    const task = db.query<TaskRow, [string]>("SELECT * FROM tasks WHERE id = ?").get(saved.task_id)
    if (task === null) throw new Error(`Missing task ${saved.task_id} for retained request`)
    return task
  }

  const findDelegation = Effect.fn("RelayStore.findDelegation")(function* (
    input: CreateTaskInput,
    principal: AuthSession | "owner",
  ) {
    const row = yield* Effect.try({
      try: () => requestedTask(input, principal),
      catch: (cause) =>
        cause instanceof TaskRequestError
          ? cause
          : operationError("RelayStore.findDelegation")(cause),
    })
    return row === null ? undefined : yield* taskFromRow(db, row)
  })
  const recordTaskTraceEvent = (
    taskId: TaskId,
    kind: TaskTraceEventKind,
    detail: string,
    createdAt: Timestamp = now(),
  ): void => {
    db.query(
      `INSERT INTO task_trace_events (task_id, kind, created_at, detail)
       VALUES (?, ?, ?, ?)`,
    ).run(taskId, kind, createdAt, detail)
    db.query(
      `DELETE FROM task_trace_events WHERE task_id = ? AND id NOT IN (
         SELECT id FROM task_trace_events WHERE task_id = ? ORDER BY id DESC LIMIT 1000
       )`,
    ).run(taskId, taskId)
  }

  const pruneTerminalHistory = (preserveTaskId?: TaskId): void => {
    const exclusion = preserveTaskId === undefined ? "" : "AND id <> ?"
    const offset = preserveTaskId === undefined ? retainedTerminalTasks : retainedTerminalTasks - 1
    const staleTasks = `SELECT id FROM tasks
      WHERE status IN ('completed', 'failed', 'cancelled')
        ${exclusion}
      ORDER BY completed_at DESC, updated_at DESC, id DESC
      LIMIT -1 OFFSET ?`
    const parameters = preserveTaskId === undefined ? [offset] : [preserveTaskId, offset]
    db.query(`DELETE FROM messages WHERE task_id IN (${staleTasks})`).run(...parameters)
    db.query(`DELETE FROM tasks WHERE id IN (${staleTasks})`).run(...parameters)
    db.query(
      `DELETE FROM threads
       WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.thread_id = threads.id)
         AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.thread_id = threads.id)`,
    ).run()
  }

  const pruneTerminalOperations = (preserveOperationId?: OperationId): void => {
    const exclusion = preserveOperationId === undefined ? "" : "AND id <> ?"
    const offset =
      preserveOperationId === undefined ? retainedTerminalTasks : retainedTerminalTasks - 1
    const parameters = preserveOperationId === undefined ? [offset] : [preserveOperationId, offset]
    db.query(
      `DELETE FROM device_operations
       WHERE id IN (
         SELECT id FROM device_operations
         WHERE status IN ('completed', 'failed') ${exclusion}
         ORDER BY completed_at DESC, updated_at DESC, id DESC
         LIMIT -1 OFFSET ?
       )`,
    ).run(...parameters)
  }

  const queryTask = (taskId: TaskId): TaskRow | null =>
    db.query<TaskRow, [string]>("SELECT * FROM tasks WHERE id = ?").get(taskId)

  const inboxColumns = `id, thread_id, target_device_id, provider, bot_id, status,
    substr(prompt, 1, 160) AS prompt_preview,
    substr(result, 1, 512) AS result_preview,
    substr(error, 1, 512) AS error_preview,
    CASE WHEN status = 'needs_input' THEN NULL ELSE COALESCE(completed_at, updated_at) END AS completed_at,
    CASE WHEN status = 'needs_input' THEN json_extract(clarifications_json, '$[#-1]') END AS input_request_json`

  const queryOperation = (operationId: OperationId): DeviceOperationRow | null =>
    db
      .query<DeviceOperationRow, [string]>("SELECT * FROM device_operations WHERE id = ?")
      .get(operationId)

  const getTask = Effect.fn("RelayStore.getTask")(function* (taskId: TaskId) {
    const row = yield* Effect.try({
      try: () => queryTask(taskId),
      catch: operationError("RelayStore.getTask"),
    })
    if (row === null) {
      return yield* Effect.fail(
        new PersistenceError({
          operation: "RelayStore.getTask",
          message: `Unknown task ${taskId}`,
          missingRecord: "task",
        }),
      )
    }
    return yield* taskFromRow(db, row)
  })

  const listAttachments = Effect.fn("RelayStore.listAttachments")(function* (taskId: TaskId) {
    yield* getTask(taskId)
    const rows = yield* Effect.try({
      try: () =>
        db
          .query<
            { readonly name: string; readonly direction: string; readonly bytes: number },
            [string]
          >(
            "SELECT name, direction, length(data) AS bytes FROM task_attachments WHERE task_id = ? ORDER BY direction, name",
          )
          .all(taskId),
      catch: operationError("RelayStore.listAttachments"),
    })
    return yield* Effect.forEach(rows, (row) =>
      decode("RelayStore.decodeAttachment", TaskAttachment, row),
    )
  })

  const readAttachment = Effect.fn("RelayStore.readAttachment")(function* (
    taskId: TaskId,
    name: AttachmentNameType,
    direction?: AttachmentDirection,
  ) {
    yield* getTask(taskId)
    const row = yield* Effect.try({
      try: () =>
        direction === undefined
          ? db
              .query<{ readonly data: Uint8Array }, [string, string]>(
                "SELECT data FROM task_attachments WHERE task_id = ? AND name = ? ORDER BY direction DESC LIMIT 1",
              )
              .get(taskId, name)
          : db
              .query<{ readonly data: Uint8Array }, [string, string, string]>(
                "SELECT data FROM task_attachments WHERE task_id = ? AND name = ? AND direction = ?",
              )
              .get(taskId, name, direction),
      catch: operationError("RelayStore.readAttachment"),
    })
    if (row === null) {
      return yield* new PersistenceError({
        operation: "RelayStore.readAttachment",
        message: `Unknown attachment ${name}`,
      })
    }
    return row.data
  })

  const inboxFor = Effect.fn("RelayStore.inboxFor")(function* (principal: AuthSession | "owner") {
    const requesterId = principal === "owner" ? "owner" : principal.id
    const rows = yield* Effect.try({
      try: () =>
        db
          .query<InboxRow, [string]>(
            `SELECT ${inboxColumns} FROM tasks WHERE requester_id = ? AND completion_seen_at IS NULL
             AND status IN ('needs_input', 'completed', 'failed', 'cancelled')
             ORDER BY COALESCE(completed_at, updated_at) ASC, id ASC LIMIT 21`,
          )
          .all(requesterId),
      catch: operationError("RelayStore.inboxFor"),
    })
    return TaskInbox.make({
      items: yield* Effect.forEach(rows.slice(0, 20), inboxItemFromRow),
      hasMore: rows.length > 20,
    })
  })

  const acknowledgeCompletion = Effect.fn("RelayStore.acknowledgeCompletion")(function* (
    taskId: TaskId,
    principal: AuthSession | "owner",
  ) {
    const requesterId = principal === "owner" ? "owner" : principal.id
    const row = yield* Effect.try({
      try: () =>
        db
          .query<InboxRow, [string, string]>(
            `SELECT ${inboxColumns} FROM tasks WHERE id = ? AND requester_id = ?
             AND status IN ('completed', 'failed', 'cancelled')`,
          )
          .get(taskId, requesterId),
      catch: operationError("RelayStore.acknowledgeCompletion.read"),
    })
    if (row === null) {
      return yield* new PersistenceError({
        operation: "RelayStore.acknowledgeCompletion",
        message: `Unknown inbox task ${taskId}`,
      })
    }
    yield* Effect.try({
      try: () =>
        db
          .query(
            "UPDATE tasks SET completion_seen_at = COALESCE(completion_seen_at, ?) WHERE id = ?",
          )
          .run(now(), taskId),
      catch: operationError("RelayStore.acknowledgeCompletion.write"),
    })
    return yield* inboxItemFromRow(row)
  })

  const traceTask = Effect.fn("RelayStore.traceTask")(function* (taskId: TaskId) {
    const task = yield* getTask(taskId)
    const [deviceRow, eventRows] = yield* Effect.try({
      try: () =>
        [
          db
            .query<DeviceRow, [string]>("SELECT * FROM devices WHERE id = ?")
            .get(task.targetDeviceId),
          db
            .query<TaskTraceEventRow, [string]>(
              `SELECT * FROM (
                 SELECT id, kind, created_at, detail FROM task_trace_events
                 WHERE task_id = ? ORDER BY id DESC LIMIT 101
               ) ORDER BY id`,
            )
            .all(taskId),
        ] as const,
      catch: operationError("RelayStore.traceTask"),
    })
    if (deviceRow === null) {
      return yield* Effect.fail(
        new PersistenceError({
          operation: "RelayStore.traceTask.device",
          message: `Unknown target device ${task.targetDeviceId}`,
        }),
      )
    }
    const targetDevice = yield* deviceFromRow(deviceRow)
    const selectedRows = eventRows.slice(-100)
    const recordedEvents = yield* Effect.forEach(selectedRows, taskTraceEventFromRow)
    const events = recordedEvents.length === 0 ? derivedTraceEvents(task) : recordedEvents
    return TaskTrace.make({
      taskId: task.id,
      threadId: task.threadId,
      status: task.status,
      provider: task.provider,
      ...(task.botId === undefined ? {} : { botId: task.botId }),
      targetDevice,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      events,
      truncated:
        eventRows.length > 100 ||
        recordedEvents.length === 0 ||
        recordedEvents[0]?.kind !== "queued",
      ...(task.sourceDeviceId === undefined ? {} : { sourceDeviceId: task.sourceDeviceId }),
      ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
      ...(task.workspace === undefined ? {} : { workspace: task.workspace }),
      ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
      ...(task.completedAt === undefined ? {} : { completedAt: task.completedAt }),
      ...(task.expiresAt === undefined ? {} : { expiresAt: task.expiresAt }),
      ...(task.error === undefined ? {} : { error: task.error }),
      ...(task.progress === undefined ? {} : { progress: task.progress }),
      ...(task.clarifications === undefined ? {} : { clarifications: task.clarifications }),
    })
  })

  const listDevices = Effect.fn("RelayStore.listDevices")(function* () {
    const rows = yield* Effect.try({
      try: () =>
        db
          .query<DeviceRow, []>(
            `SELECT devices.*, COUNT(tasks.id) AS queued_tasks,
                    MIN(tasks.created_at) AS oldest_queued_at
             FROM devices LEFT JOIN tasks
               ON tasks.target_device_id = devices.id AND tasks.status = 'queued'
             WHERE devices.forgotten_at IS NULL
             GROUP BY devices.id ORDER BY devices.name COLLATE NOCASE, devices.id`,
          )
          .all(),
      catch: operationError("RelayStore.listDevices"),
    })
    return yield* Effect.forEach(rows, deviceFromRow)
  })

  const listDevicePage = Effect.fn("RelayStore.listDevicePage")(function* (after?: DeviceId) {
    const nextRow = yield* Effect.try({
      try: () =>
        db.query<DeviceRow, [string]>(
          `SELECT devices.*,
                  (SELECT COUNT(*) FROM tasks
                   WHERE target_device_id = devices.id AND status = 'queued') AS queued_tasks,
                  (SELECT MIN(created_at) FROM tasks
                   WHERE target_device_id = devices.id AND status = 'queued') AS oldest_queued_at
           FROM devices WHERE forgotten_at IS NULL AND devices.id > ?
           ORDER BY devices.id LIMIT 1`,
        ),
      catch: operationError("RelayStore.listDevicePage.query"),
    })
    const devices: Array<Device> = []
    const targetBytes = 2 * 1024 * 1024 - 1024
    let bytes = 0
    let cursor = after ?? ""
    while (devices.length < maxDevicePageDevices) {
      const row = yield* Effect.try({
        try: () => nextRow.get(cursor),
        catch: operationError("RelayStore.listDevicePage.read"),
      })
      if (row === null) break
      const device = yield* deviceFromRow(row)
      const size = Buffer.byteLength(JSON.stringify(device)) + (devices.length === 0 ? 0 : 1)
      if (devices.length > 0 && bytes + size > targetBytes) break
      devices.push(device)
      bytes += size
      cursor = device.id
      if (bytes > targetBytes) break
    }
    const last = devices.at(-1)
    const hasMore =
      last !== undefined &&
      (yield* Effect.try({
        try: () =>
          db
            .query<{ readonly found: number }, [string]>(
              "SELECT 1 AS found FROM devices WHERE forgotten_at IS NULL AND id > ? ORDER BY id LIMIT 1",
            )
            .get(last.id) !== null,
        catch: operationError("RelayStore.listDevicePage.hasMore"),
      }))
    const page = DevicePage.make({
      devices,
      ...(hasMore && last !== undefined ? { nextCursor: last.id } : {}),
    })
    if (Buffer.byteLength(JSON.stringify(page)) > maxDevicePageResponseBytes)
      return yield* new PersistenceError({
        operation: "RelayStore.listDevicePage",
        message: "A device page exceeds the transfer limit",
      })
    return page
  })

  const usage = Effect.fn("RelayStore.usage")(function* () {
    const rows = yield* Effect.try({
      try: () =>
        db
          .query<UsageRow, []>(
            `SELECT tasks.target_device_id AS device_id, devices.name AS device_name,
                    tasks.status, tasks.provider, COUNT(*) AS tasks
             FROM tasks
             JOIN devices ON devices.id = tasks.target_device_id
             GROUP BY tasks.target_device_id, devices.name, tasks.status, tasks.provider
             ORDER BY devices.name COLLATE NOCASE, tasks.target_device_id, tasks.provider`,
          )
          .all(),
      catch: operationError("RelayStore.usage"),
    })
    const totalStatus = emptyStatusCounts()
    const totalProviders = new Map<Provider, number>()
    const devices = new Map<
      DeviceId,
      {
        readonly name: string
        readonly status: Record<TaskStatus, number>
        readonly providers: Map<Provider, number>
      }
    >()
    let retainedTasks = 0
    for (const row of rows) {
      const status = Schema.decodeUnknownSync(TaskStatus)(row.status)
      const provider = Schema.decodeUnknownSync(Provider)(row.provider)
      const deviceId = Schema.decodeUnknownSync(DeviceId)(row.device_id)
      retainedTasks += row.tasks
      totalStatus[status] += row.tasks
      totalProviders.set(provider, (totalProviders.get(provider) ?? 0) + row.tasks)
      const current = devices.get(deviceId) ?? {
        name: row.device_name,
        status: emptyStatusCounts(),
        providers: new Map<Provider, number>(),
      }
      current.status[status] += row.tasks
      current.providers.set(provider, (current.providers.get(provider) ?? 0) + row.tasks)
      devices.set(deviceId, current)
    }
    const providerUsage = (providers: ReadonlyMap<Provider, number>) =>
      Provider.literals.flatMap((provider) => {
        const tasks = providers.get(provider)
        return tasks === undefined ? [] : [{ provider, tasks }]
      })
    return UsageSummary.make({
      retainedTasks,
      byStatus: TaskStatusCounts.make(totalStatus),
      byProvider: providerUsage(totalProviders),
      devices: [...devices.entries()].map(([deviceId, device]) =>
        DeviceUsage.make({
          deviceId,
          deviceName: device.name,
          tasks: Object.values(device.status).reduce((sum, tasks) => sum + tasks, 0),
          byStatus: TaskStatusCounts.make(device.status),
          byProvider: providerUsage(device.providers),
        }),
      ),
    })
  })

  const getOperation = Effect.fn("RelayStore.getOperation")(function* (operationId: OperationId) {
    const row = yield* Effect.try({
      try: () => queryOperation(operationId),
      catch: operationError("RelayStore.getOperation"),
    })
    if (row === null) {
      return yield* Effect.fail(
        new PersistenceError({
          operation: "RelayStore.getOperation",
          message: `Unknown device operation ${operationId}`,
          missingRecord: "operation",
        }),
      )
    }
    return yield* operationFromRow(row)
  })

  const listOperations = Effect.fn("RelayStore.listOperations")(function* () {
    const rows = yield* Effect.try({
      try: () =>
        db
          .query<DeviceOperationRow, []>(
            "SELECT * FROM device_operations ORDER BY created_at DESC, id DESC LIMIT 50",
          )
          .all(),
      catch: operationError("RelayStore.listOperations"),
    })
    return yield* Effect.forEach(rows, operationFromRow)
  })

  const createUpgradeOperations = Effect.fn("RelayStore.createUpgradeOperations")(function* (
    input: CreateUpgradeOperationsInput,
  ) {
    const timestamp = now()
    const operations = yield* Effect.try({
      try: () =>
        db.transaction(() => {
          const devices = db
            .query<DeviceRow, []>(
              "SELECT * FROM devices WHERE forgotten_at IS NULL ORDER BY name COLLATE NOCASE, id",
            )
            .all()
          if (devices.length === 0) {
            throw new Error("No Cohall devices are registered")
          }
          if (devices.length > 256) {
            throw new Error("All-device operations support at most 256 registered devices")
          }
          assertDeviceOperationSupport(devices)
          for (const device of devices) {
            const outstanding = db
              .query<{ readonly count: number }, [string]>(
                `SELECT COUNT(*) AS count FROM device_operations
                 WHERE target_device_id = ? AND status IN ('queued', 'assigned', 'running')`,
              )
              .get(device.id)
            if ((outstanding?.count ?? 0) > 0) {
              throw new Error(`${device.name} already has an upgrade operation in progress`)
            }
          }
          pruneTerminalOperations()
          return devices.map((device) => {
            const operation = DeviceOperation.make({
              id: makeOperationId(),
              kind: "upgrade",
              status: "queued",
              targetDeviceId: DeviceId.make(device.id),
              requestedVersion: input.target,
              restart: input.restart,
              createdAt: timestamp,
              updatedAt: timestamp,
            })
            db.query(
              `INSERT INTO device_operations (
                 id, kind, status, target_device_id, requested_version, restart,
                 created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              operation.id,
              operation.kind,
              operation.status,
              operation.targetDeviceId,
              operation.requestedVersion,
              operation.restart ? 1 : 0,
              operation.createdAt,
              operation.updatedAt,
            )
            return operation
          })
        })(),
      catch: operationError("RelayStore.createUpgradeOperations"),
    })
    return operations
  })

  const pendingOperationsFor = Effect.fn("RelayStore.pendingOperationsFor")(function* (
    deviceId: DeviceId,
  ) {
    const rows = yield* Effect.try({
      try: () =>
        db
          .query<DeviceOperationRow, [string]>(
            `SELECT * FROM device_operations WHERE target_device_id = ? AND status = 'queued'
             ORDER BY created_at, id LIMIT 10`,
          )
          .all(deviceId),
      catch: operationError("RelayStore.pendingOperationsFor"),
    })
    return yield* Effect.forEach(rows, operationFromRow)
  })

  const transitionOperation = Effect.fn("RelayStore.transitionOperation")(function* (
    operationId: OperationId,
    expected: ReadonlyArray<OperationStatus>,
    status: OperationStatus,
    result?: string,
    error?: string,
  ) {
    const current = yield* getOperation(operationId)
    if (!expected.includes(current.status)) {
      return current
    }
    const timestamp = now()
    const completed = status === "completed" || status === "failed" ? timestamp : undefined
    const placeholders = expected.map(() => "?").join(", ")
    yield* Effect.try({
      try: () =>
        db.transaction(() => {
          const updated = db
            .query(
              `UPDATE device_operations
               SET status = ?, result = ?, error = ?, updated_at = ?, completed_at = ?
               WHERE id = ? AND status IN (${placeholders})`,
            )
            .run(
              status,
              result ?? current.result ?? null,
              error ?? current.error ?? null,
              timestamp,
              completed ?? current.completedAt ?? null,
              operationId,
              ...expected,
            )
          if (updated.changes === 1 && completed !== undefined) {
            pruneTerminalOperations(operationId)
          }
        })(),
      catch: operationError("RelayStore.transitionOperation"),
    })
    return yield* getOperation(operationId)
  })

  const requireOperationTarget = Effect.fn("RelayStore.requireOperationTarget")(function* (
    operationId: OperationId,
    deviceId: DeviceId,
  ) {
    const operation = yield* getOperation(operationId)
    if (operation.targetDeviceId !== deviceId) {
      return yield* Effect.fail(
        new PersistenceError({
          operation: "RelayStore.requireOperationTarget",
          message: `Device ${deviceId} cannot update operation ${operationId}`,
        }),
      )
    }
    return operation
  })

  const assignOperation = Effect.fn("RelayStore.assignOperation")(function* (
    operationId: OperationId,
  ) {
    const current = yield* getOperation(operationId)
    if (current.status !== "queued") {
      return current
    }
    const timestamp = now()
    yield* Effect.try({
      try: () =>
        db
          .query(
            `UPDATE device_operations SET status = 'assigned', updated_at = ?
             WHERE id = ? AND status = 'queued'
               AND NOT EXISTS (
                 SELECT 1 FROM tasks WHERE target_device_id = ?
                   AND status IN ('assigned', 'running', 'cancelling')
               )
               AND NOT EXISTS (
                 SELECT 1 FROM device_operations active
                 WHERE active.target_device_id = ? AND active.id <> ?
                   AND active.status IN ('assigned', 'running')
               )`,
          )
          .run(timestamp, operationId, current.targetDeviceId, current.targetDeviceId, operationId),
      catch: operationError("RelayStore.assignOperation"),
    })
    return yield* getOperation(operationId)
  })

  const acceptOperation = (operationId: OperationId, deviceId: DeviceId) =>
    requireOperationTarget(operationId, deviceId).pipe(
      Effect.flatMap(() => transitionOperation(operationId, ["assigned"], "running")),
    )

  const finishOperation = (operationId: OperationId, deviceId: DeviceId, result: string) =>
    requireOperationTarget(operationId, deviceId).pipe(
      Effect.flatMap(() =>
        transitionOperation(operationId, ["queued", "assigned", "running"], "completed", result),
      ),
    )

  const failOperation = (operationId: OperationId, deviceId: DeviceId, error: string) =>
    requireOperationTarget(operationId, deviceId).pipe(
      Effect.flatMap(() =>
        transitionOperation(
          operationId,
          ["queued", "assigned", "running"],
          "failed",
          undefined,
          error,
        ),
      ),
    )

  const abandonOperation = (operationId: OperationId) =>
    transitionOperation(
      operationId,
      ["queued", "assigned", "running"],
      "failed",
      undefined,
      "Abandoned by the relay owner",
    )

  const requeueOperationsFor = Effect.fn("RelayStore.requeueOperationsFor")(function* (
    deviceId: DeviceId,
  ) {
    yield* Effect.try({
      try: () =>
        db
          .query(
            `UPDATE device_operations SET status = 'queued', updated_at = ?
             WHERE target_device_id = ? AND status IN ('assigned', 'running')`,
          )
          .run(now(), deviceId),
      catch: operationError("RelayStore.requeueOperationsFor"),
    })
  })

  const forgetDevice = Effect.fn("RelayStore.forgetDevice")(function* (deviceId: DeviceId) {
    const row = yield* Effect.try({
      try: () =>
        db.transaction(() => {
          const device = db
            .query<DeviceRow, [string]>(
              "SELECT * FROM devices WHERE id = ? AND forgotten_at IS NULL",
            )
            .get(deviceId)
          if (device === null) {
            throw new Error(`Unknown device ${deviceId}`)
          }
          if (device.status !== "offline") {
            throw new Error(`Device ${deviceId} must be offline before it can be forgotten`)
          }
          const outstanding = db
            .query<{ readonly count: number }, [string]>(
              `SELECT COUNT(*) AS count FROM tasks
               WHERE target_device_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`,
            )
            .get(deviceId)
          if ((outstanding?.count ?? 0) > 0) {
            throw new Error(`Device ${deviceId} still has outstanding tasks`)
          }
          const timestamp = now()
          db.query(
            `UPDATE device_operations
             SET status = 'failed', error = ?, updated_at = ?, completed_at = ?
             WHERE target_device_id = ? AND status IN ('queued', 'assigned', 'running')`,
          ).run("Target device was forgotten by the relay owner", timestamp, timestamp, deviceId)
          pruneTerminalOperations()
          db.query("UPDATE devices SET forgotten_at = ? WHERE id = ?").run(timestamp, deviceId)
          db.query(
            "UPDATE auth_sessions SET revoked_at = ? WHERE bound_device_id = ? AND revoked_at IS NULL",
          ).run(timestamp, deviceId)
          return device
        })(),
      catch: operationError("RelayStore.forgetDevice"),
    })
    return yield* deviceFromRow(row)
  })

  const recover = Effect.fn("RelayStore.recover")(function* () {
    yield* Effect.try({
      try: () =>
        db.transaction(() => {
          const timestamp = now()
          const interrupted = db
            .query<{ readonly id: string; readonly status: "queued" | "needs_input" }, []>(
              `SELECT id, ${interruptedTaskStatus} AS status FROM tasks WHERE status IN ('assigned', 'running')`,
            )
            .all()
          db.query("UPDATE devices SET status = 'offline'").run()
          db.query(
            `UPDATE tasks SET status = ${interruptedTaskStatus}, updated_at = ?, progress_note = NULL, progress_at = NULL,
             dispatched_at = CASE WHEN provider = 'grok-bot' THEN dispatched_at
               ELSE COALESCE(dispatched_at, started_at, updated_at) END
             WHERE status IN ('assigned', 'running')`,
          ).run(timestamp)
          db.query(
            "UPDATE device_operations SET status = 'queued', updated_at = ? WHERE status IN ('assigned', 'running')",
          ).run(timestamp)
          for (const task of interrupted) {
            recordTaskTraceEvent(
              TaskId.make(task.id),
              task.status === "needs_input" ? "needs_input" : "requeued",
              "Relay restarted before the task completed",
              timestamp,
            )
          }
          db.query("DELETE FROM auth_pairings WHERE expires_at <= ? OR used_at IS NOT NULL").run(
            timestamp,
          )
          db.query(
            "UPDATE auth_sessions SET revoked_at = ? WHERE revoked_at IS NULL AND roles_json LIKE '%,%'",
          ).run(timestamp)
          pruneTerminalHistory()
          pruneTerminalOperations()
        })(),
      catch: operationError("RelayStore.recover"),
    })
  })

  const upsertDevice = Effect.fn("RelayStore.upsertDevice")(function* (device: Device) {
    yield* Effect.try({
      try: () =>
        db
          .query(
            `INSERT INTO devices (
            id, name, hostname, platform, architecture, status, providers_json,
            capabilities_json, workspaces_json, version, last_seen_at, connected_at, bots_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name, hostname = excluded.hostname, platform = excluded.platform,
            architecture = excluded.architecture, status = excluded.status,
            providers_json = excluded.providers_json, bots_json = excluded.bots_json,
            capabilities_json = excluded.capabilities_json,
            workspaces_json = excluded.workspaces_json, version = excluded.version,
            last_seen_at = excluded.last_seen_at, connected_at = excluded.connected_at,
            forgotten_at = NULL`,
          )
          .run(
            device.id,
            device.name,
            device.hostname,
            device.platform,
            device.architecture,
            device.status,
            JSON.stringify(device.providers),
            JSON.stringify(device.capabilities),
            JSON.stringify(device.workspaces),
            device.version,
            device.lastSeenAt,
            device.connectedAt ?? null,
            device.bots === undefined ? null : JSON.stringify(device.bots),
          ),
      catch: operationError("RelayStore.upsertDevice"),
    })
    return device
  })

  const updateDeviceStatus = Effect.fn("RelayStore.updateDeviceStatus")(function* (
    deviceId: DeviceId,
    status: "online" | "busy" | "offline",
    bots?: Device["bots"],
  ) {
    const timestamp = now()
    const result = yield* Effect.try({
      try: () =>
        db
          .query(
            "UPDATE devices SET status = ?, last_seen_at = ?, bots_json = COALESCE(?, bots_json) WHERE id = ?",
          )
          .run(status, timestamp, bots === undefined ? null : JSON.stringify(bots), deviceId),
      catch: operationError("RelayStore.updateDeviceStatus"),
    })
    if (result.changes !== 1) {
      return yield* Effect.fail(
        new PersistenceError({
          operation: "RelayStore.updateDeviceStatus",
          message: `Unknown device ${deviceId}`,
        }),
      )
    }
    const row = db.query<DeviceRow, [string]>("SELECT * FROM devices WHERE id = ?").get(deviceId)
    if (row === null) {
      return yield* Effect.fail(
        new PersistenceError({
          operation: "RelayStore.updateDeviceStatus.read",
          message: `Device ${deviceId} disappeared after update`,
        }),
      )
    }
    return yield* deviceFromRow(row)
  })

  const createDelegation = Effect.fn("RelayStore.createDelegation")(function* (
    input: CreateTaskInput,
    targetDeviceId: DeviceId,
    principal: AuthSession | "owner",
    providerSessionId?: string,
    requestedInput: CreateTaskInput = input,
  ) {
    const requesterId = principal === "owner" ? "owner" : principal.id
    const boundDeviceId = principal === "owner" ? undefined : principal.deviceId
    const sourceDeviceId = yield* Effect.try({
      try: () =>
        boundDeviceId === undefined ||
        db
          .query("SELECT id FROM devices WHERE id = ? AND forgotten_at IS NULL")
          .get(boundDeviceId) === null
          ? undefined
          : boundDeviceId,
      catch: operationError("RelayStore.createDelegation.source"),
    })
    const submission = yield* Effect.try({
      try: () =>
        db.transaction(() => {
          const existing = requestedTask(requestedInput, principal)
          if (existing !== null) return { existing }
          if (input.expiresAt !== undefined) {
            if (input.provider === "grok-bot" || input.botId !== undefined)
              throw new TaskDeadlineError({
                status: 400,
                message: "Task deadlines require a coding provider",
              })
            if (taskDeadlinePassed(input))
              throw new TaskDeadlineError({
                status: 400,
                message: "Task deadline must be in the future",
              })
          }
          const timestamp = now()
          const threadId = input.threadId ?? makeThreadId()
          const task = Task.make({
            id: makeTaskId(),
            threadId,
            prompt: input.prompt,
            provider: input.provider ?? (input.botId === undefined ? "codex" : "grok-bot"),
            ...(input.botId === undefined ? {} : { botId: input.botId }),
            status: "queued",
            targetDeviceId,
            createdAt: timestamp,
            updatedAt: timestamp,
            ...(input.expiresAt === undefined
              ? {}
              : { expiresAt: Timestamp.make(new Date(input.expiresAt).toISOString()) }),
            ...(input.context === undefined ? {} : { context: input.context }),
            ...(sourceDeviceId === undefined ? {} : { sourceDeviceId }),
            ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
            ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
            ...(input.attachments === undefined || input.attachments.length === 0
              ? {}
              : { inputAttachmentNames: input.attachments.map((attachment) => attachment.name) }),
            ...(providerSessionId === undefined ? {} : { providerSessionId }),
          })
          const thread =
            input.threadId === undefined
              ? Thread.make({
                  id: threadId,
                  title: input.title ?? input.prompt.slice(0, 72),
                  createdAt: timestamp,
                  updatedAt: timestamp,
                })
              : undefined
          const message = Message.make({
            id: makeMessageId(),
            threadId,
            role: "human",
            authorName: sourceDeviceId === undefined ? "User" : "Remote agent",
            content: input.prompt,
            createdAt: timestamp,
            taskId: task.id,
            ...(sourceDeviceId === undefined ? {} : { deviceId: sourceDeviceId }),
          })
          const outstanding = db
            .query<{ readonly count: number }, [string]>(
              `SELECT COUNT(*) AS count FROM tasks WHERE target_device_id = ?
               AND status IN ('queued', 'assigned', 'running', 'needs_input', 'cancelling')`,
            )
            .get(targetDeviceId)
          if ((outstanding?.count ?? 0) >= 100) {
            throw new Error(`Device ${targetDeviceId} has reached its outstanding task limit`)
          }
          if (thread !== undefined) {
            db.query(
              "INSERT INTO threads (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
            ).run(thread.id, thread.title, thread.createdAt, thread.updatedAt)
          } else if (
            db
              .query<{ readonly id: string }, [string]>("SELECT id FROM threads WHERE id = ?")
              .get(threadId) === null
          ) {
            throw new Error(`Unknown thread ${threadId}`)
          }
          db.query(
            `INSERT INTO tasks (
              id, thread_id, prompt, context, provider, status, source_device_id,
              requester_id, target_device_id, parent_task_id, workspace,
              provider_session_id, bot_id, created_at, updated_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            task.id,
            task.threadId,
            task.prompt,
            task.context ?? null,
            task.provider,
            task.status,
            task.sourceDeviceId ?? null,
            requesterId,
            task.targetDeviceId,
            task.parentTaskId ?? null,
            task.workspace ?? null,
            task.providerSessionId ?? null,
            task.botId ?? null,
            task.createdAt,
            task.updatedAt,
            task.expiresAt ?? null,
          )
          for (const attachment of input.attachments ?? []) {
            const data = Buffer.from(attachment.data, "base64")
            if (data.length < 1 || data.length > maxAttachmentBytes) {
              throw new Error(
                `Attachment ${attachment.name} must be 1 to ${maxAttachmentBytes} bytes`,
              )
            }
            db.query(
              "INSERT INTO task_attachments (task_id, name, direction, data) VALUES (?, ?, 'input', ?)",
            ).run(task.id, attachment.name, data)
          }
          if (requestedInput.requestId !== undefined) {
            db.query(
              "INSERT INTO task_requests (requester_id, request_id, input_hash, task_id) VALUES (?, ?, ?, ?)",
            ).run(
              requesterId,
              requestedInput.requestId.toLowerCase(),
              requestHash(requestedInput),
              task.id,
            )
          }
          recordTaskTraceEvent(task.id, "queued", "Relay accepted the task", timestamp)
          db.query(
            `INSERT INTO messages (
              id, thread_id, role, kind, author_id, author_name, content, created_at,
              task_id, device_id
            ) VALUES (?, ?, ?, 'chat', ?, ?, ?, ?, ?, ?)`,
          ).run(
            message.id,
            message.threadId,
            message.role,
            sourceDeviceId ?? "user",
            message.authorName,
            message.content,
            message.createdAt,
            message.taskId ?? null,
            message.deviceId ?? null,
          )
          db.query("UPDATE threads SET updated_at = ? WHERE id = ?").run(timestamp, threadId)
          return { created: task }
        })(),
      catch: (cause) =>
        cause instanceof TaskRequestError || cause instanceof TaskDeadlineError
          ? cause
          : operationError("RelayStore.createDelegation")(cause),
    })
    return "existing" in submission
      ? yield* taskFromRow(db, submission.existing)
      : submission.created
  })

  const threadContext = Effect.fn("RelayStore.threadContext")(function* (threadId: ThreadId) {
    const threadRow = yield* Effect.try({
      try: () => db.query<ThreadRow, [string]>("SELECT * FROM threads WHERE id = ?").get(threadId),
      catch: operationError("RelayStore.threadContext.thread"),
    })
    if (threadRow === null) {
      return yield* Effect.fail(
        new PersistenceError({
          operation: "RelayStore.threadContext",
          message: `Unknown thread ${threadId}`,
        }),
      )
    }
    const [messageRows, taskRows] = yield* Effect.try({
      try: () =>
        [
          db
            .query<MessageRow, [string]>(
              `SELECT * FROM (
                 SELECT * FROM messages WHERE thread_id = ?
                 ORDER BY created_at DESC, id DESC LIMIT 21
               ) ORDER BY created_at, id`,
            )
            .all(threadId),
          db
            .query<TaskRow, [string]>(
              `SELECT * FROM (
                 SELECT * FROM tasks WHERE thread_id = ?
                 ORDER BY created_at DESC, id DESC LIMIT 21
               ) ORDER BY created_at, id`,
            )
            .all(threadId),
        ] as const,
      catch: operationError("RelayStore.threadContext.items"),
    })
    const [thread, messages, tasks] = yield* Effect.all([
      threadFromRow(threadRow),
      Effect.forEach(messageRows.slice(-20), messageFromRow),
      Effect.forEach(taskRows.slice(-20), (row) => taskFromRow(db, row)),
    ])
    const recentMessages = recentWithin(messages, 256 * 1024)
    const recentTasks = recentWithin(tasks, 768 * 1024)
    return ThreadContext.make({
      thread,
      messages: recentMessages.items,
      tasks: recentTasks.items,
      truncated:
        messageRows.length > 20 ||
        taskRows.length > 20 ||
        recentMessages.truncated ||
        recentTasks.truncated,
    })
  })

  const pendingTasksFor = Effect.fn("RelayStore.pendingTasksFor")(function* (deviceId: DeviceId) {
    const rows = yield* Effect.try({
      try: () =>
        db
          .query<TaskRow, [string]>(
            `SELECT * FROM tasks WHERE target_device_id = ?
           AND status IN ('queued', 'cancelling') ORDER BY created_at, id LIMIT 100`,
          )
          .all(deviceId),
      catch: operationError("RelayStore.pendingTasksFor"),
    })
    return yield* Effect.forEach(rows, (row) => taskFromRow(db, row))
  })

  const transition = Effect.fn("RelayStore.transition")(function* (
    taskId: TaskId,
    expected: ReadonlyArray<TaskStatus>,
    update: TaskUpdate,
    event?: { readonly kind: TaskTraceEventKind; readonly detail: string },
  ) {
    const current = yield* getTask(taskId)
    if (!expected.includes(current.status)) {
      return current
    }
    const placeholders = expected.map(() => "?").join(", ")
    const timestamp = now()
    yield* Effect.try({
      try: () =>
        db.transaction(() => {
          const result = db
            .query(
              `UPDATE tasks SET status = ?, provider_session_id = ?, result = ?, error = ?,
             started_at = ?, completed_at = ?, updated_at = ?
             WHERE id = ? AND status IN (${placeholders})`,
            )
            .run(
              update.status ?? current.status,
              update.providerSessionId ?? current.providerSessionId ?? null,
              update.result ?? current.result ?? null,
              update.error ?? current.error ?? null,
              update.startedAt ?? current.startedAt ?? null,
              update.completedAt ?? current.completedAt ?? null,
              timestamp,
              taskId,
              ...expected,
            )
          if (result.changes === 1 && event !== undefined) {
            recordTaskTraceEvent(taskId, event.kind, event.detail, timestamp)
          }
          if (
            result.changes === 1 &&
            update.status !== undefined &&
            ["completed", "failed", "cancelled"].includes(update.status)
          ) {
            pruneTerminalHistory(taskId)
          }
        })(),
      catch: operationError("RelayStore.transition"),
    })
    return yield* getTask(taskId)
  })

  const hasDispatchEvidence = Effect.fn("RelayStore.hasDispatchEvidence")((taskId: TaskId) =>
    Effect.try({
      try: () =>
        db.query("SELECT 1 FROM tasks WHERE id = ? AND dispatched_at IS NOT NULL").get(taskId) !==
        null,
      catch: operationError("RelayStore.hasDispatchEvidence"),
    }),
  )

  const expireTask = Effect.fn("RelayStore.expireTask")(function* (task: Task) {
    if (
      !taskDeadlinePassed(task) ||
      ["cancelling", "completed", "failed", "cancelled"].includes(task.status)
    )
      return task
    const neverDispatched =
      task.status === "queued" &&
      task.runId === undefined &&
      task.startedAt === undefined &&
      !(yield* hasDispatchEvidence(task.id))
    return yield* transition(
      task.id,
      [task.status],
      {
        status: neverDispatched ? "failed" : "cancelling",
        error: taskDeadlineError,
        ...(neverDispatched ? { completedAt: now() } : {}),
      },
      { kind: neverDispatched ? "failed" : "cancelling", detail: taskDeadlineError },
    )
  })

  const expireTasks = Effect.fn("RelayStore.expireTasks")(function* () {
    const rows = yield* Effect.try({
      try: () =>
        db
          .query<TaskRow, [string]>(
            `SELECT * FROM tasks WHERE expires_at <= ? AND status IN ('queued', 'assigned', 'running', 'needs_input')
         ORDER BY expires_at, id LIMIT 100`,
          )
          .all(now()),
      catch: operationError("RelayStore.expireTasks"),
    })
    return yield* Effect.forEach(rows, (row) =>
      taskFromRow(db, row).pipe(Effect.flatMap(expireTask)),
    )
  })

  const assignTask = Effect.fn("RelayStore.assignTask")(function* (taskId: TaskId) {
    const current = yield* getTask(taskId).pipe(Effect.flatMap(expireTask))
    if (current.status !== "queued") {
      return current
    }
    const timestamp = now()
    yield* Effect.try({
      try: () =>
        db.transaction(() => {
          const result = db
            .query(
              `UPDATE tasks SET status = 'assigned', updated_at = ?, run_id = CASE
                 WHEN dispatched_at IS NOT NULL OR started_at IS NOT NULL OR (
                   provider = 'grok-bot' AND NOT EXISTS (
                     SELECT 1 FROM devices, json_each(devices.capabilities_json) capability
                     WHERE devices.id = tasks.target_device_id
                       AND json_extract(capability.value, '$.id') = 'task-clarification'
                   )
                 )
                   THEN run_id ELSE COALESCE(run_id, ?) END,
                 provider_session_id = CASE
                   WHEN provider = 'grok-bot' THEN NULL
                   WHEN started_at IS NULL THEN COALESCE((
                     SELECT session_id FROM provider_sessions
                     WHERE thread_id = tasks.thread_id AND device_id = tasks.target_device_id
                       AND provider = tasks.provider
                   ), provider_session_id)
                   ELSE provider_session_id END
               WHERE id = ? AND status = 'queued' AND NOT EXISTS (
                 SELECT 1 FROM tasks active
                 WHERE active.target_device_id = ? AND active.id <> ?
                   AND CASE WHEN active.provider = 'grok-bot'
                     THEN 'grok-bot:' || active.bot_id ELSE 'cli' END = ?
                   AND active.status IN ('assigned', 'running', 'cancelling')
               ) AND NOT EXISTS (
                 SELECT 1 FROM device_operations active
                 WHERE active.target_device_id = ?
                   AND active.status IN ('assigned', 'running')
               )`,
            )
            .run(
              timestamp,
              crypto.randomUUID(),
              taskId,
              current.targetDeviceId,
              taskId,
              taskSlot(current),
              current.targetDeviceId,
            )
          if (result.changes === 1) {
            recordTaskTraceEvent(
              taskId,
              "assigned",
              "Relay dispatched the task over the device WebSocket",
              timestamp,
            )
          }
        })(),
      catch: operationError("RelayStore.assignTask"),
    })
    return yield* getTask(taskId)
  })

  const requireTarget = Effect.fn("RelayStore.requireTarget")(function* (
    taskId: TaskId,
    deviceId: DeviceId,
  ) {
    const task = yield* getTask(taskId)
    if (task.targetDeviceId !== deviceId) {
      return yield* Effect.fail(
        new PersistenceError({
          operation: "RelayStore.requireTarget",
          message: `Task ${taskId} belongs to another device`,
        }),
      )
    }
    return task
  })

  const reportTaskProgress = Effect.fn("RelayStore.reportTaskProgress")(function* (
    taskId: TaskId,
    deviceId: DeviceId,
    note: TaskProgressInput["note"],
  ) {
    const task = yield* getTask(taskId)
    if (task.targetDeviceId !== deviceId) {
      return yield* new TaskProgressError({
        status: 403,
        message: "Only the target device can report progress",
      })
    }
    const progress = TaskProgress.make({ note, at: now() })
    const changed = yield* Effect.try({
      try: () =>
        db
          .query(
            `UPDATE tasks SET progress_note = ?, progress_at = ?, updated_at = ?
         WHERE id = ? AND target_device_id = ? AND status = 'running'`,
          )
          .run(note, progress.at, progress.at, taskId, deviceId).changes,
      catch: operationError("RelayStore.reportTaskProgress"),
    })
    if (changed !== 1) {
      return yield* new TaskProgressError({
        status: 409,
        message: "Task must be running to report progress",
      })
    }
    return progress
  })

  const requestTaskInput = Effect.fn("RelayStore.requestTaskInput")(function* (
    taskId: TaskId,
    deviceId: DeviceId,
    input: RequestTaskInput,
  ) {
    const task = yield* getTask(taskId)
    if (task.targetDeviceId !== deviceId) {
      return yield* new TaskInputError({
        status: 403,
        message: "Only the target device can request input",
      })
    }
    if (taskDeadlinePassed(task))
      return yield* new TaskInputError({ status: 409, message: taskDeadlineError })
    if (task.status !== "running" || task.runId !== input.runId) {
      return yield* new TaskInputError({
        status: 409,
        message: "Input can only be requested by the current running turn",
      })
    }
    const row = yield* Effect.try({
      try: () => db.query<DeviceRow, [string]>("SELECT * FROM devices WHERE id = ?").get(deviceId),
      catch: operationError("RelayStore.requestTaskInput.device"),
    })
    const device = row === null ? undefined : yield* deviceFromRow(row)
    if (!device?.capabilities.some((capability) => capability.id === "task-clarification")) {
      return yield* new TaskInputError({
        status: 409,
        message: "Upgrade the target worker before requesting clarification",
      })
    }
    const history = task.clarifications ?? []
    const pending = history.at(-1)
    if (pending !== undefined && pending.answer === undefined) {
      if (pending.question === input.question) return pending
      return yield* new TaskInputError({
        status: 409,
        message: "This task already has an unanswered question",
      })
    }
    if (history.length >= maxTaskClarifications) {
      return yield* new TaskInputError({
        status: 409,
        message: `A task supports at most ${maxTaskClarifications} clarifications`,
      })
    }
    const question = TaskClarification.make({
      id: ClarificationId.make(crypto.randomUUID()),
      question: input.question,
      at: now(),
    })
    const changed = yield* Effect.try({
      try: () =>
        db.transaction(() => {
          const result = db
            .query(
              `UPDATE tasks SET clarifications_json = ?, updated_at = ?
           WHERE id = ? AND status = 'running' AND run_id = ?
             AND COALESCE(clarifications_json, '[]') = ?`,
            )
            .run(
              JSON.stringify([...history, question]),
              question.at,
              taskId,
              input.runId,
              JSON.stringify(history),
            )
          if (result.changes === 1)
            recordTaskTraceEvent(
              taskId,
              "input_requested",
              "Worker requested clarification and is ending its turn",
              question.at,
            )
          return result.changes
        })(),
      catch: operationError("RelayStore.requestTaskInput"),
    })
    if (changed !== 1)
      return yield* new TaskInputError({
        status: 409,
        message: "Task changed while requesting input; check its status",
      })
    return question
  })

  const answerTaskInput = Effect.fn("RelayStore.answerTaskInput")(function* (
    taskId: TaskId,
    principal: AuthSession | "owner",
    input: AnswerTaskInput,
  ) {
    const task = yield* getTask(taskId)
    const requester = yield* Effect.try({
      try: () => queryTask(taskId)?.requester_id,
      catch: operationError("RelayStore.answerTaskInput.requester"),
    })
    if (principal !== "owner" && (principal.role !== "client" || requester !== principal.id)) {
      return yield* new TaskInputError({
        status: 403,
        message: "Only the original requester or relay owner can answer",
      })
    }
    if (taskDeadlinePassed(task))
      return yield* new TaskInputError({ status: 409, message: taskDeadlineError })
    const history = task.clarifications ?? []
    const question = history.at(-1)
    if (
      task.status !== "needs_input" ||
      question?.id !== input.requestId ||
      question.answer !== undefined
    ) {
      return yield* new TaskInputError({
        status: 409,
        message: "This question is no longer awaiting an answer; check task status",
      })
    }
    const timestamp = now()
    const answered = TaskClarification.make({
      ...question,
      answer: { text: input.answer, at: timestamp },
    })
    const changed = yield* Effect.try({
      try: () =>
        db.transaction(() => {
          const result = db
            .query(
              `UPDATE tasks SET status = 'queued', run_id = ?, clarifications_json = ?, updated_at = ?,
             result = NULL, error = NULL, completed_at = NULL, progress_note = NULL, progress_at = NULL,
             started_at = CASE WHEN provider = 'grok-bot' THEN NULL ELSE started_at END,
             dispatched_at = NULL
           WHERE id = ? AND status = 'needs_input' AND clarifications_json = ?`,
            )
            .run(
              crypto.randomUUID(),
              JSON.stringify([...history.slice(0, -1), answered]),
              timestamp,
              taskId,
              JSON.stringify(history),
            )
          if (result.changes === 1) {
            recordTaskTraceEvent(
              taskId,
              "input_answered",
              "Requester answered the worker's question",
              timestamp,
            )
            recordTaskTraceEvent(
              taskId,
              "queued",
              "Task queued to resume with the answer",
              timestamp,
            )
          }
          return result.changes
        })(),
      catch: operationError("RelayStore.answerTaskInput"),
    })
    if (changed !== 1)
      return yield* new TaskInputError({
        status: 409,
        message: "Task changed while answering; check its status",
      })
    return yield* getTask(taskId)
  })

  const matchesTaskRun = (task: Task, runId: TaskRunId | undefined): boolean =>
    task.runId === undefined ||
    task.runId === runId ||
    (runId === undefined && (task.clarifications?.length ?? 0) === 0)

  const terminal = Effect.fn("RelayStore.terminal")(function* (
    taskId: TaskId,
    deviceId: DeviceId,
    status: "completed" | "failed" | "cancelled",
    result?: string,
    error?: string,
    providerSessionId?: string,
    attachments?: ReadonlyArray<InputAttachment>,
    runId?: TaskRunId,
  ) {
    const current = yield* requireTarget(taskId, deviceId)
    if (
      !matchesTaskRun(current, runId) ||
      (current.status === "cancelling" && status !== "cancelled") ||
      ["completed", "failed", "cancelled"].includes(current.status)
    ) {
      return current
    }
    if (taskDeadlinePassed(current) && status !== "cancelled") return yield* expireTask(current)
    const deadlineExpired =
      taskDeadlinePassed(current) &&
      (current.status !== "cancelling" || current.error === taskDeadlineError)
    const finalStatus = status === "cancelled" && deadlineExpired ? "failed" : status
    const finalError = finalStatus === "failed" && deadlineExpired ? taskDeadlineError : error
    const timestamp = now()
    yield* Effect.try({
      try: () =>
        db.transaction(() => {
          const saveProviderSession = () => {
            if (current.provider === "grok-bot" || providerSessionId === undefined) return
            db.query(
              `INSERT INTO provider_sessions (thread_id, device_id, provider, session_id, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(thread_id, device_id, provider) DO UPDATE SET
               session_id = excluded.session_id, updated_at = excluded.updated_at`,
            ).run(current.threadId, deviceId, current.provider, providerSessionId, timestamp)
          }
          if (current.status === "needs_input" && status !== "cancelled") {
            if (current.provider === "grok-bot" || providerSessionId === undefined) return
            const updated = db
              .query(
                `UPDATE tasks SET provider_session_id = ?, updated_at = ?
                 WHERE id = ? AND status = 'needs_input' AND run_id IS ?`,
              )
              .run(providerSessionId, timestamp, taskId, current.runId ?? null)
            if (updated.changes === 1) saveProviderSession()
            return
          }
          if (
            status !== "cancelled" &&
            current.clarifications?.at(-1)?.answer === undefined &&
            (current.clarifications?.length ?? 0) > 0 &&
            current.status === "running"
          ) {
            const changed = db
              .query(
                `UPDATE tasks SET status = 'needs_input', provider_session_id = ?, updated_at = ?,
               progress_note = NULL, progress_at = NULL
               WHERE id = ? AND status = 'running' AND run_id IS ?`,
              )
              .run(
                current.provider === "grok-bot"
                  ? null
                  : (providerSessionId ?? current.providerSessionId ?? null),
                timestamp,
                taskId,
                current.runId ?? null,
              )
            if (changed.changes === 1) {
              saveProviderSession()
              recordTaskTraceEvent(
                taskId,
                "needs_input",
                "Worker paused for clarification",
                timestamp,
              )
            }
            return
          }
          const updated = db
            .query(
              `UPDATE tasks SET status = ?, result = ?, error = ?, provider_session_id = ?,
             completed_at = ?, updated_at = ?, progress_note = NULL, progress_at = NULL WHERE id = ?
             AND status NOT IN ('completed', 'failed', 'cancelled')
             AND (status <> 'needs_input' OR ? = 'cancelled')
             AND (status <> 'cancelling' OR ? = 'cancelled') AND run_id IS ?`,
            )
            .run(
              finalStatus,
              result ?? null,
              finalError ?? null,
              current.provider === "grok-bot"
                ? null
                : (providerSessionId ?? current.providerSessionId ?? null),
              timestamp,
              timestamp,
              taskId,
              status,
              status,
              current.runId ?? null,
            )
          if (updated.changes !== 1) {
            return
          }
          db.query("DELETE FROM task_attachments WHERE task_id = ? AND direction = 'output'").run(
            taskId,
          )
          if (finalStatus === "completed") {
            if ((attachments?.length ?? 0) > maxTaskAttachments) {
              throw new Error(`A task supports at most ${maxTaskAttachments} output files`)
            }
            for (const attachment of attachments ?? []) {
              const data = Buffer.from(attachment.data, "base64")
              if (data.length < 1 || data.length > maxAttachmentBytes) {
                throw new Error(
                  `Attachment ${attachment.name} must be 1 to ${maxAttachmentBytes} bytes`,
                )
              }
              db.query(
                "INSERT INTO task_attachments (task_id, name, direction, data) VALUES (?, ?, 'output', ?)",
              ).run(taskId, attachment.name, data)
            }
          }
          recordTaskTraceEvent(
            taskId,
            finalStatus,
            finalStatus === "completed"
              ? "Target device completed the task"
              : finalStatus === "failed"
                ? "Target device reported a task failure"
                : "Target device acknowledged cancellation",
            timestamp,
          )
          saveProviderSession()
          const content = result ?? finalError
          if (content !== undefined) {
            const role = finalStatus === "completed" ? "agent" : "system"
            db.query(
              `INSERT INTO messages (
                id, thread_id, role, kind, author_id, author_name, content, created_at,
                task_id, device_id
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              makeMessageId(),
              current.threadId,
              role,
              finalStatus === "failed" ? "error" : "chat",
              deviceId,
              finalStatus === "completed" ? providerName(current.provider) : "Cohall",
              content,
              timestamp,
              taskId,
              deviceId,
            )
            db.query("UPDATE threads SET updated_at = ? WHERE id = ?").run(
              timestamp,
              current.threadId,
            )
          }
          pruneTerminalHistory(taskId)
        })(),
      catch: operationError("RelayStore.terminal"),
    })
    return yield* getTask(taskId)
  })

  const requestCancellation = Effect.fn("RelayStore.requestCancellation")(function* (
    taskId: TaskId,
  ) {
    const current = yield* getTask(taskId).pipe(Effect.flatMap(expireTask))
    if (["completed", "failed", "cancelled"].includes(current.status)) {
      return current
    }
    const dispatched = yield* hasDispatchEvidence(taskId)
    if (
      current.provider === "grok-bot" &&
      current.status !== "needs_input" &&
      (current.status !== "queued" || current.startedAt !== undefined || dispatched)
    ) {
      return yield* new PersistenceError({
        operation: "RelayStore.requestCancellation",
        message:
          "Stop this bot in Grok Bot; its gateway cannot cancel an individual Cohall request",
      })
    }
    if (current.status === "cancelling") {
      return current
    }
    const timestamp = now()
    const neverDispatched =
      current.status === "queued" &&
      !dispatched &&
      (current.provider === "grok-bot" ||
        (current.runId === undefined && current.startedAt === undefined))
    return neverDispatched || (current.status === "needs_input" && current.provider === "grok-bot")
      ? yield* transition(
          taskId,
          ["queued", "needs_input"],
          { status: "cancelled", completedAt: timestamp },
          { kind: "cancelled", detail: "Client cancelled the task before dispatch" },
        )
      : yield* transition(
          taskId,
          ["queued", "assigned", "running", "needs_input"],
          {
            status: "cancelling",
          },
          { kind: "cancelling", detail: "Client requested task cancellation" },
        )
  })

  const requeueTasksFor = Effect.fn("RelayStore.requeueTasksFor")(function* (deviceId: DeviceId) {
    const timestamp = now()
    yield* Effect.try({
      try: () =>
        db.transaction(() => {
          const interrupted = db
            .query<{ readonly id: string; readonly status: "queued" | "needs_input" }, [string]>(
              `SELECT id, ${interruptedTaskStatus} AS status FROM tasks WHERE target_device_id = ?
               AND status IN ('assigned', 'running')`,
            )
            .all(deviceId)
          db.query(
            `UPDATE tasks SET status = ${interruptedTaskStatus}, updated_at = ?, progress_note = NULL, progress_at = NULL,
             dispatched_at = CASE WHEN provider = 'grok-bot' THEN dispatched_at
               ELSE COALESCE(dispatched_at, started_at, updated_at) END
             WHERE target_device_id = ? AND status IN ('assigned', 'running')`,
          ).run(timestamp, deviceId)
          for (const task of interrupted) {
            recordTaskTraceEvent(
              TaskId.make(task.id),
              task.status === "needs_input" ? "needs_input" : "requeued",
              "Target device disconnected before task completion",
              timestamp,
            )
          }
        })(),
      catch: operationError("RelayStore.requeueTasksFor"),
    })
  })

  const sessionFor = Effect.fn("RelayStore.sessionFor")(function* (
    threadId: ThreadId,
    deviceId: DeviceId,
    provider: Provider,
  ) {
    const row = yield* Effect.try({
      try: () =>
        db
          .query<{ readonly session_id: string }, [string, string, string]>(
            `SELECT session_id FROM provider_sessions
           WHERE thread_id = ? AND device_id = ? AND provider = ?`,
          )
          .get(threadId, deviceId, provider),
      catch: operationError("RelayStore.sessionFor"),
    })
    return row?.session_id
  })

  const createPairing = Effect.fn("RelayStore.createPairing")(function* (
    input: CreatePairingInput,
  ) {
    const roles = [...new Set(input.roles)]
    if (roles.length === 0) {
      return yield* Effect.fail(
        new PersistenceError({
          operation: "RelayStore.createPairing",
          message: "A pairing must allow at least one role",
        }),
      )
    }
    const token = secret("pair")
    const expiresAt = new Date(Date.now() + 10 * 60 * 1_000).toISOString()
    yield* Effect.try({
      try: () =>
        db
          .query(
            `INSERT INTO auth_pairings (token_hash, label, roles_json, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          )
          .run(tokenHash(token), input.label, JSON.stringify(roles), expiresAt, now()),
      catch: operationError("RelayStore.createPairing"),
    })
    return PairingCredential.make({ token, expiresAt: Timestamp.make(expiresAt) })
  })

  const exchangePairing = Effect.fn("RelayStore.exchangePairing")(function* (token: string) {
    const timestamp = now()
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000).toISOString()
    const created = yield* Effect.try({
      try: () =>
        db.transaction(() => {
          const pairing = db
            .query<PairingRow, [string, string]>(
              `SELECT * FROM auth_pairings
             WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
            )
            .get(tokenHash(token), timestamp)
          if (pairing === null) {
            throw new Error("Pairing credential is invalid, expired, or already used")
          }
          const roles = Schema.decodeUnknownSync(Schema.Array(ConnectionRole))(
            JSON.parse(pairing.roles_json),
          )
          const deviceId = roles.includes("device") ? makeDeviceId() : undefined
          const consumed = db
            .query("UPDATE auth_pairings SET used_at = ? WHERE token_hash = ? AND used_at IS NULL")
            .run(timestamp, pairing.token_hash)
          if (consumed.changes !== 1) {
            throw new Error("Pairing credential was already used")
          }
          return [...new Set(roles)].map((role) => {
            const sessionToken = secret("session")
            const row = {
              id: makeAuthSessionId(),
              token_hash: tokenHash(sessionToken),
              label: pairing.label,
              roles_json: JSON.stringify([role]),
              created_at: timestamp,
              expires_at: expiresAt,
              last_seen_at: timestamp,
              bound_device_id: deviceId ?? null,
              revoked_at: null,
            } satisfies AuthSessionRow
            db.query(
              `INSERT INTO auth_sessions (
                id, token_hash, label, roles_json, created_at, expires_at, last_seen_at,
                bound_device_id
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              row.id,
              row.token_hash,
              row.label,
              row.roles_json,
              row.created_at,
              row.expires_at,
              row.last_seen_at,
              row.bound_device_id,
            )
            return { token: sessionToken, row }
          })
        })(),
      catch: operationError("RelayStore.exchangePairing"),
    })
    const credentials = yield* Effect.forEach(created, ({ token: sessionToken, row }) =>
      authSessionFromRow(row).pipe(Effect.map((session) => ({ token: sessionToken, session }))),
    )
    return PairingResult.make({ credentials })
  })

  const authenticateSession = Effect.fn("RelayStore.authenticateSession")(function* (
    token: string,
    role: ConnectionRoleName,
  ) {
    const row = yield* Effect.try({
      try: () =>
        db
          .query<AuthSessionRow, [string, string]>(
            `SELECT * FROM auth_sessions
           WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
          )
          .get(tokenHash(token), now()),
      catch: operationError("RelayStore.authenticateSession"),
    })
    if (row === null || !rolesFromRow(row).includes(role)) {
      return undefined
    }
    const lastSeenAt = now()
    yield* Effect.try({
      try: () =>
        db.query("UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?").run(lastSeenAt, row.id),
      catch: operationError("RelayStore.authenticateSession.touch"),
    })
    const session = yield* authSessionFromRow(row)
    return AuthSession.make({ ...session, lastSeenAt })
  })

  const listAuthSessions = Effect.fn("RelayStore.listAuthSessions")(function* () {
    const rows = yield* Effect.try({
      try: () =>
        db
          .query<AuthSessionRow, []>(
            "SELECT * FROM auth_sessions ORDER BY created_at DESC, id LIMIT 1000",
          )
          .all(),
      catch: operationError("RelayStore.listAuthSessions"),
    })
    return yield* Effect.forEach(rows, authSessionFromRow)
  })

  const revokeAuthSession = Effect.fn("RelayStore.revokeAuthSession")(function* (
    sessionId: AuthSessionId,
  ) {
    const revokedAt = now()
    const result = yield* Effect.try({
      try: () =>
        db
          .query("UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
          .run(revokedAt, sessionId),
      catch: operationError("RelayStore.revokeAuthSession"),
    })
    if (result.changes !== 1) {
      return yield* Effect.fail(
        new PersistenceError({
          operation: "RelayStore.revokeAuthSession",
          message: `Unknown or already revoked session ${sessionId}`,
        }),
      )
    }
    const row = db
      .query<AuthSessionRow, [string]>("SELECT * FROM auth_sessions WHERE id = ?")
      .get(sessionId)
    if (row === null) {
      return yield* Effect.fail(
        new PersistenceError({
          operation: "RelayStore.revokeAuthSession.read",
          message: `Session ${sessionId} disappeared after revocation`,
        }),
      )
    }
    return yield* authSessionFromRow(row)
  })

  return Service.of({
    recover,
    listDevices,
    listDevicePage,
    usage,
    forgetDevice,
    upsertDevice,
    heartbeat: (deviceId, status, bots) => updateDeviceStatus(deviceId, status, bots),
    markDeviceOffline: (deviceId) => updateDeviceStatus(deviceId, "offline"),
    createDelegation,
    expireTasks,
    findDelegation,
    getTask,
    reportTaskProgress,
    requestTaskInput,
    answerTaskInput,
    listAttachments,
    readAttachment,
    inboxFor,
    acknowledgeCompletion,
    traceTask,
    threadContext,
    pendingTasksFor,
    assignTask,
    markTaskDispatched: (taskId) =>
      Effect.try({
        try: () => {
          db.query(
            "UPDATE tasks SET dispatched_at = COALESCE(dispatched_at, ?) WHERE id = ? AND status = 'assigned'",
          ).run(now(), taskId)
        },
        catch: operationError("RelayStore.markTaskDispatched"),
      }),
    rollbackAssignment: (taskId) =>
      transition(
        taskId,
        ["assigned"],
        { status: "queued" },
        { kind: "requeued", detail: "Target device was unavailable during dispatch" },
      ),
    acceptTask: (taskId, deviceId, runId) =>
      requireTarget(taskId, deviceId).pipe(
        Effect.flatMap((task) =>
          matchesTaskRun(task, runId)
            ? transition(
                taskId,
                ["assigned"],
                { status: "running", startedAt: now() },
                {
                  kind: "running",
                  detail: "Target device accepted the task and started the provider",
                },
              )
            : Effect.succeed(task),
        ),
      ),
    finishTask: (taskId, deviceId, result, providerSessionId, attachments, runId) =>
      terminal(
        taskId,
        deviceId,
        "completed",
        result,
        undefined,
        providerSessionId,
        attachments,
        runId,
      ),
    failTask: (taskId, deviceId, error, runId) =>
      terminal(taskId, deviceId, "failed", undefined, error, undefined, undefined, runId),
    acknowledgeCancellation: (taskId, deviceId, runId) =>
      terminal(taskId, deviceId, "cancelled", undefined, undefined, undefined, undefined, runId),
    requestCancellation,
    requeueTasksFor,
    createUpgradeOperations,
    listOperations,
    abandonOperation,
    pendingOperationsFor,
    assignOperation,
    rollbackOperation: (operationId) => transitionOperation(operationId, ["assigned"], "queued"),
    acceptOperation,
    finishOperation,
    failOperation,
    requeueOperationsFor,
    sessionFor,
    createPairing,
    exchangePairing,
    authenticateSession,
    listAuthSessions,
    revokeAuthSession,
  })
}

const migrate = (db: Database): Effect.Effect<void, PersistenceError> =>
  Effect.try({
    try: () => {
      db.exec("PRAGMA journal_mode = WAL")
      db.exec("PRAGMA foreign_keys = ON")
      db.exec("PRAGMA busy_timeout = 5000")
      db.exec(`
        CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, hostname TEXT NOT NULL,
          platform TEXT NOT NULL, architecture TEXT NOT NULL, status TEXT NOT NULL,
          providers_json TEXT NOT NULL, bots_json TEXT, capabilities_json TEXT NOT NULL,
          workspaces_json TEXT NOT NULL, version TEXT NOT NULL, last_seen_at TEXT NOT NULL,
          connected_at TEXT, forgotten_at TEXT
        );
        CREATE TABLE IF NOT EXISTS threads (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL, archived_at TEXT,
          default_device_id TEXT REFERENCES devices(id)
        );
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          role TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'chat', author_id TEXT NOT NULL,
          author_name TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL,
          task_id TEXT, reply_to TEXT, device_id TEXT REFERENCES devices(id)
        );
        CREATE INDEX IF NOT EXISTS messages_thread_created ON messages(thread_id, created_at);
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          prompt TEXT NOT NULL, context TEXT, provider TEXT NOT NULL, bot_id TEXT, status TEXT NOT NULL,
          source_device_id TEXT REFERENCES devices(id),
          requester_id TEXT, completion_seen_at TEXT,
          target_device_id TEXT NOT NULL REFERENCES devices(id), parent_task_id TEXT,
          workspace TEXT, provider_session_id TEXT, result TEXT, error TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, completed_at TEXT,
          dispatched_at TEXT, progress_note TEXT, progress_at TEXT,
          run_id TEXT, clarifications_json TEXT, expires_at TEXT
        );
        CREATE INDEX IF NOT EXISTS tasks_thread_created ON tasks(thread_id, created_at);
        CREATE INDEX IF NOT EXISTS tasks_target_status ON tasks(target_device_id, status);
        CREATE TABLE IF NOT EXISTS task_requests (
          requester_id TEXT NOT NULL, request_id TEXT NOT NULL, input_hash TEXT NOT NULL,
          task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          PRIMARY KEY(requester_id, request_id)
        );
        CREATE INDEX IF NOT EXISTS task_requests_retained_task
          ON task_requests(task_id) WHERE task_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS task_attachments (
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          name TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('input', 'output')),
          data BLOB NOT NULL CHECK(length(data) BETWEEN 1 AND ${maxAttachmentBytes}),
          PRIMARY KEY(task_id, direction, name)
        );
        CREATE TABLE IF NOT EXISTS task_trace_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          kind TEXT NOT NULL, created_at TEXT NOT NULL, detail TEXT
        );
        CREATE INDEX IF NOT EXISTS task_trace_events_task_id
          ON task_trace_events(task_id, id);
        CREATE TABLE IF NOT EXISTS provider_sessions (
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
          provider TEXT NOT NULL, session_id TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY(thread_id, device_id, provider)
        );
        CREATE TABLE IF NOT EXISTS device_operations (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
          target_device_id TEXT NOT NULL REFERENCES devices(id),
          requested_version TEXT NOT NULL, restart INTEGER NOT NULL,
          result TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS device_operations_target_status
          ON device_operations(target_device_id, status);
        CREATE TABLE IF NOT EXISTS auth_pairings (
          token_hash TEXT PRIMARY KEY, label TEXT NOT NULL, roles_json TEXT NOT NULL,
          expires_at TEXT NOT NULL, created_at TEXT NOT NULL, used_at TEXT
        );
        CREATE TABLE IF NOT EXISTS auth_sessions (
          id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
          roles_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL, bound_device_id TEXT, revoked_at TEXT
        );
        CREATE INDEX IF NOT EXISTS auth_sessions_token ON auth_sessions(token_hash);
      `)
      const deviceColumns = db
        .query<{ readonly name: string }, []>("PRAGMA table_info(devices)")
        .all()
      if (!deviceColumns.some((column) => column.name === "forgotten_at")) {
        db.exec("ALTER TABLE devices ADD COLUMN forgotten_at TEXT")
      }
      if (!deviceColumns.some((column) => column.name === "bots_json")) {
        db.exec("ALTER TABLE devices ADD COLUMN bots_json TEXT")
      }
      const taskColumns = db.query<{ readonly name: string }, []>("PRAGMA table_info(tasks)").all()
      if (!taskColumns.some((column) => column.name === "expires_at"))
        db.exec("ALTER TABLE tasks ADD COLUMN expires_at TEXT")
      db.exec(
        "CREATE INDEX IF NOT EXISTS tasks_pending_deadline ON tasks(expires_at) WHERE status IN ('queued', 'assigned', 'running', 'needs_input')",
      )
      if (!taskColumns.some((column) => column.name === "run_id"))
        db.exec("ALTER TABLE tasks ADD COLUMN run_id TEXT")
      if (!taskColumns.some((column) => column.name === "clarifications_json"))
        db.exec("ALTER TABLE tasks ADD COLUMN clarifications_json TEXT")
      if (!taskColumns.some((column) => column.name === "progress_note")) {
        db.exec("ALTER TABLE tasks ADD COLUMN progress_note TEXT")
      }
      if (!taskColumns.some((column) => column.name === "progress_at")) {
        db.exec("ALTER TABLE tasks ADD COLUMN progress_at TEXT")
      }
      if (!taskColumns.some((column) => column.name === "bot_id")) {
        db.exec("ALTER TABLE tasks ADD COLUMN bot_id TEXT")
      }
      if (!taskColumns.some((column) => column.name === "requester_id")) {
        db.exec("ALTER TABLE tasks ADD COLUMN requester_id TEXT")
      }
      if (!taskColumns.some((column) => column.name === "completion_seen_at")) {
        db.exec("ALTER TABLE tasks ADD COLUMN completion_seen_at TEXT")
      }
      db.exec(`CREATE INDEX IF NOT EXISTS tasks_inbox
        ON tasks(requester_id, completion_seen_at, completed_at)`)
      if (!taskColumns.some((column) => column.name === "dispatched_at")) {
        db.transaction(() => {
          db.exec("ALTER TABLE tasks ADD COLUMN dispatched_at TEXT")
          // Older queued Bot tasks may already be running with a lost acceptance event.
          db.exec(`UPDATE tasks SET dispatched_at = COALESCE(started_at, updated_at)
            WHERE provider = 'grok-bot' AND status NOT IN ('completed', 'failed', 'cancelled')`)
        })()
      }
      // Legacy coding assignments may be running even when their acceptance event was lost.
      db.exec(`UPDATE tasks SET dispatched_at = COALESCE(started_at, updated_at)
        WHERE provider <> 'grok-bot' AND dispatched_at IS NULL AND run_id IS NULL
          AND status NOT IN ('completed', 'failed', 'cancelled')
          AND (status IN ('assigned', 'running') OR started_at IS NOT NULL OR EXISTS (
            SELECT 1 FROM task_trace_events
            WHERE task_id = tasks.id AND kind IN ('assigned', 'running')
          ))`)
    },
    catch: operationError("RelayStore.migrate"),
  })

export const layer = (path: string, retainedTerminalTasks = 1_000) =>
  Layer.effect(
    Service,
    Effect.acquireRelease(
      Effect.try({
        try: () => new Database(path),
        catch: operationError("RelayStore.open"),
      }).pipe(Effect.tap(migrate)),
      (db) => Effect.sync(() => db.close()),
    ).pipe(Effect.map((db) => makeService(db, retainedTerminalTasks))),
  )

export const layerFromDatabase = (db: Database) =>
  Layer.effect(Service, migrate(db).pipe(Effect.map(() => makeService(db))))

export * as RelayStore from "./store.ts"
