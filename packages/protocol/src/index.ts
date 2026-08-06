import { Schema } from "effect"

declare const __COHALL_VERSION__: string
export const version =
  typeof __COHALL_VERSION__ === "undefined" ? "0.0.0-development" : __COHALL_VERSION__

const bounded = (maxLength: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maxLength))
const optionalText = (maxLength: number) => Schema.String.check(Schema.isMaxLength(maxLength))
const boundedArray = <S extends Schema.Top>(schema: S, maxLength: number) =>
  Schema.Array(schema).check(Schema.isMaxLength(maxLength))
const uuid = <Name extends string>(name: Name) =>
  Schema.String.check(Schema.isUUID(4)).pipe(Schema.brand(name))
const isoTimestamp = <Name extends string>(name: Name) =>
  Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/, {
      expected: "an ISO-8601 UTC timestamp",
    }),
  ).pipe(Schema.brand(name))

export const DeviceId = uuid("DeviceId")
export type DeviceId = typeof DeviceId.Type
export const ThreadId = uuid("ThreadId")
export type ThreadId = typeof ThreadId.Type
export const MessageId = uuid("MessageId")
export type MessageId = typeof MessageId.Type
export const TaskId = uuid("TaskId")
export type TaskId = typeof TaskId.Type
export const AuthSessionId = uuid("AuthSessionId")
export type AuthSessionId = typeof AuthSessionId.Type
export const Timestamp = isoTimestamp("Timestamp")
export type Timestamp = typeof Timestamp.Type

export const Platform = Schema.Literals(["darwin", "linux", "windows", "unknown"])
export type Platform = typeof Platform.Type
export const Provider = Schema.Literals(["codex", "claude-code", "opencode"])
export type Provider = typeof Provider.Type
export const DeviceStatus = Schema.Literals(["online", "busy", "offline"])
export type DeviceStatus = typeof DeviceStatus.Type
export const TaskStatus = Schema.Literals([
  "queued",
  "assigned",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
])
export type TaskStatus = typeof TaskStatus.Type
export const TaskTraceEventKind = Schema.Literals([...TaskStatus.literals, "requeued"])
export type TaskTraceEventKind = typeof TaskTraceEventKind.Type
export const MessageRole = Schema.Literals(["human", "agent", "system"])
export type MessageRole = typeof MessageRole.Type
export const ConnectionRole = Schema.Literals(["client", "device"])
export type ConnectionRole = typeof ConnectionRole.Type

export const AuthSession = Schema.Struct({
  id: AuthSessionId,
  label: bounded(128),
  role: ConnectionRole,
  createdAt: Timestamp,
  expiresAt: Timestamp,
  lastSeenAt: Timestamp,
  deviceId: Schema.optionalKey(DeviceId),
  revokedAt: Schema.optionalKey(Timestamp),
})
export interface AuthSession extends Schema.Schema.Type<typeof AuthSession> {}

export const CreatePairingInput = Schema.Struct({
  label: bounded(128),
  roles: boundedArray(ConnectionRole, 2),
})
export interface CreatePairingInput extends Schema.Schema.Type<typeof CreatePairingInput> {}

export const PairingCredential = Schema.Struct({
  token: bounded(256),
  expiresAt: Timestamp,
})
export interface PairingCredential extends Schema.Schema.Type<typeof PairingCredential> {}

export const ExchangePairingInput = Schema.Struct({
  token: bounded(256),
})
export interface ExchangePairingInput extends Schema.Schema.Type<typeof ExchangePairingInput> {}

export const SessionCredential = Schema.Struct({
  token: bounded(256),
  session: AuthSession,
})
export interface SessionCredential extends Schema.Schema.Type<typeof SessionCredential> {}

export const PairingResult = Schema.Struct({
  credentials: boundedArray(SessionCredential, 2),
})
export interface PairingResult extends Schema.Schema.Type<typeof PairingResult> {}

export const Capability = Schema.Struct({
  id: bounded(64),
  label: bounded(128),
  detail: Schema.optionalKey(optionalText(512)),
})
export interface Capability extends Schema.Schema.Type<typeof Capability> {}

export const Workspace = Schema.Struct({
  path: bounded(4096),
  label: bounded(256),
})
export interface Workspace extends Schema.Schema.Type<typeof Workspace> {}

export const Device = Schema.Struct({
  id: DeviceId,
  name: bounded(128),
  hostname: bounded(256),
  platform: Platform,
  architecture: bounded(64),
  status: DeviceStatus,
  providers: boundedArray(Provider, 3),
  capabilities: boundedArray(Capability, 64),
  workspaces: boundedArray(Workspace, 64),
  version: bounded(32),
  lastSeenAt: Timestamp,
  connectedAt: Schema.optionalKey(Timestamp),
})
export interface Device extends Schema.Schema.Type<typeof Device> {}

export const Thread = Schema.Struct({
  id: ThreadId,
  title: bounded(256),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  defaultDeviceId: Schema.optionalKey(DeviceId),
})
export interface Thread extends Schema.Schema.Type<typeof Thread> {}

export const Message = Schema.Struct({
  id: MessageId,
  threadId: ThreadId,
  role: MessageRole,
  authorName: bounded(128),
  content: optionalText(131_072),
  createdAt: Timestamp,
  taskId: Schema.optionalKey(TaskId),
  deviceId: Schema.optionalKey(DeviceId),
})
export interface Message extends Schema.Schema.Type<typeof Message> {}

export const Task = Schema.Struct({
  id: TaskId,
  threadId: ThreadId,
  prompt: bounded(131_072),
  context: Schema.optionalKey(optionalText(131_072)),
  provider: Provider,
  status: TaskStatus,
  sourceDeviceId: Schema.optionalKey(DeviceId),
  targetDeviceId: DeviceId,
  parentTaskId: Schema.optionalKey(TaskId),
  workspace: Schema.optionalKey(bounded(4096)),
  providerSessionId: Schema.optionalKey(bounded(4096)),
  result: Schema.optionalKey(optionalText(131_072)),
  error: Schema.optionalKey(optionalText(16_384)),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  startedAt: Schema.optionalKey(Timestamp),
  completedAt: Schema.optionalKey(Timestamp),
})
export interface Task extends Schema.Schema.Type<typeof Task> {}

export const TaskTraceEvent = Schema.Struct({
  kind: TaskTraceEventKind,
  at: Timestamp,
  detail: Schema.optionalKey(optionalText(512)),
})
export interface TaskTraceEvent extends Schema.Schema.Type<typeof TaskTraceEvent> {}

export const TaskTrace = Schema.Struct({
  taskId: TaskId,
  threadId: ThreadId,
  status: TaskStatus,
  provider: Provider,
  sourceDeviceId: Schema.optionalKey(DeviceId),
  targetDevice: Device,
  parentTaskId: Schema.optionalKey(TaskId),
  workspace: Schema.optionalKey(bounded(4096)),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  startedAt: Schema.optionalKey(Timestamp),
  completedAt: Schema.optionalKey(Timestamp),
  events: boundedArray(TaskTraceEvent, 100),
  truncated: Schema.Boolean,
  error: Schema.optionalKey(optionalText(16_384)),
})
export interface TaskTrace extends Schema.Schema.Type<typeof TaskTrace> {}

export const ThreadContext = Schema.Struct({
  thread: Thread,
  messages: boundedArray(Message, 20),
  tasks: boundedArray(Task, 20),
  truncated: Schema.Boolean,
})
export interface ThreadContext extends Schema.Schema.Type<typeof ThreadContext> {}

export const CreateTaskInput = Schema.Struct({
  threadId: Schema.optionalKey(ThreadId),
  title: Schema.optionalKey(bounded(256)),
  prompt: bounded(131_072),
  context: Schema.optionalKey(optionalText(131_072)),
  provider: Schema.optionalKey(Provider),
  targetDeviceId: Schema.optionalKey(DeviceId),
  parentTaskId: Schema.optionalKey(TaskId),
  workspace: Schema.optionalKey(bounded(4096)),
})
export interface CreateTaskInput extends Schema.Schema.Type<typeof CreateTaskInput> {}

export const SocketEvent = Schema.TaggedUnion({
  Authenticate: { token: bounded(256) },
  Connected: { serverVersion: bounded(32), connectedAt: Timestamp },
  DeviceHello: { device: Device },
  DeviceHeartbeat: { deviceId: DeviceId, status: DeviceStatus },
  TaskAssigned: { task: Task },
  TaskAccepted: { taskId: TaskId },
  TaskFinished: {
    taskId: TaskId,
    result: optionalText(131_072),
    providerSessionId: Schema.optionalKey(bounded(4096)),
  },
  TaskFailed: { taskId: TaskId, error: bounded(16_384) },
  TaskCancelled: { taskId: TaskId },
  TaskSettled: { taskId: TaskId },
  CancelTask: { taskId: TaskId },
  Error: { code: bounded(64), message: bounded(2048) },
})
export type SocketEvent = typeof SocketEvent.Type

export const ErrorResponse = Schema.Struct({
  error: bounded(2048),
})
export interface ErrorResponse extends Schema.Schema.Type<typeof ErrorResponse> {}

export const terminalTaskStatuses: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
])
export const isTerminalTask = (task: Task): boolean => terminalTaskStatuses.has(task.status)
export const now = (): Timestamp => Timestamp.make(new Date().toISOString())
export const makeDeviceId = (): DeviceId => DeviceId.make(crypto.randomUUID())
export const makeThreadId = (): ThreadId => ThreadId.make(crypto.randomUUID())
export const makeMessageId = (): MessageId => MessageId.make(crypto.randomUUID())
export const makeTaskId = (): TaskId => TaskId.make(crypto.randomUUID())
export const makeAuthSessionId = (): AuthSessionId => AuthSessionId.make(crypto.randomUUID())

export const decodeCreatePairingInput = Schema.decodeUnknownEffect(CreatePairingInput)
export const decodeExchangePairingInput = Schema.decodeUnknownEffect(ExchangePairingInput)
export const decodeCreateTaskInput = Schema.decodeUnknownEffect(CreateTaskInput)
export const decodeDevice = Schema.decodeUnknownEffect(Device)
export const decodeSocketEvent = Schema.decodeUnknownEffect(SocketEvent)
