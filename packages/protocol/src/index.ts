import { Schema } from "effect"

const uuid = <Name extends string>(name: Name) =>
  Schema.String.check(Schema.isUUID(4)).pipe(Schema.brand(name))

const isoTimestamp = <Name extends string>(name: Name) =>
  Schema.String.check(
    Schema.isPattern(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/,
      { expected: "an ISO-8601 UTC timestamp" },
    ),
  ).pipe(Schema.brand(name))

export const DeviceId = uuid("DeviceId")
export type DeviceId = typeof DeviceId.Type

export const ThreadId = uuid("ThreadId")
export type ThreadId = typeof ThreadId.Type

export const MessageId = uuid("MessageId")
export type MessageId = typeof MessageId.Type

export const TaskId = uuid("TaskId")
export type TaskId = typeof TaskId.Type

export const ArtifactId = uuid("ArtifactId")
export type ArtifactId = typeof ArtifactId.Type

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
  "waiting",
  "completed",
  "failed",
  "cancelled",
])
export type TaskStatus = typeof TaskStatus.Type

export const MessageRole = Schema.Literals(["human", "agent", "system", "tool"])
export type MessageRole = typeof MessageRole.Type

export const MessageKind = Schema.Literals(["chat", "reasoning", "tool", "status", "error"])
export type MessageKind = typeof MessageKind.Type

export const Capability = Schema.Struct({
  id: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
  detail: Schema.optionalKey(Schema.String),
})
export interface Capability extends Schema.Schema.Type<typeof Capability> {}

export const Workspace = Schema.Struct({
  path: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
  repository: Schema.optionalKey(Schema.String),
})
export interface Workspace extends Schema.Schema.Type<typeof Workspace> {}

export const Device = Schema.Struct({
  id: DeviceId,
  name: Schema.NonEmptyString,
  hostname: Schema.NonEmptyString,
  platform: Platform,
  architecture: Schema.NonEmptyString,
  status: DeviceStatus,
  providers: Schema.Array(Provider),
  capabilities: Schema.Array(Capability),
  workspaces: Schema.Array(Workspace),
  version: Schema.NonEmptyString,
  lastSeenAt: Timestamp,
  connectedAt: Schema.optionalKey(Timestamp),
})
export interface Device extends Schema.Schema.Type<typeof Device> {}

export const Thread = Schema.Struct({
  id: ThreadId,
  title: Schema.NonEmptyString,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  archivedAt: Schema.optionalKey(Timestamp),
  defaultDeviceId: Schema.optionalKey(DeviceId),
})
export interface Thread extends Schema.Schema.Type<typeof Thread> {}

export const Message = Schema.Struct({
  id: MessageId,
  threadId: ThreadId,
  role: MessageRole,
  kind: MessageKind,
  authorId: Schema.NonEmptyString,
  authorName: Schema.NonEmptyString,
  content: Schema.String,
  createdAt: Timestamp,
  taskId: Schema.optionalKey(TaskId),
  replyTo: Schema.optionalKey(MessageId),
  deviceId: Schema.optionalKey(DeviceId),
})
export interface Message extends Schema.Schema.Type<typeof Message> {}

export const Task = Schema.Struct({
  id: TaskId,
  threadId: ThreadId,
  prompt: Schema.NonEmptyString,
  context: Schema.optionalKey(Schema.String),
  provider: Provider,
  status: TaskStatus,
  sourceDeviceId: Schema.optionalKey(DeviceId),
  targetDeviceId: DeviceId,
  parentTaskId: Schema.optionalKey(TaskId),
  workspace: Schema.optionalKey(Schema.String),
  providerSessionId: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  startedAt: Schema.optionalKey(Timestamp),
  completedAt: Schema.optionalKey(Timestamp),
})
export interface Task extends Schema.Schema.Type<typeof Task> {}

export const Artifact = Schema.Struct({
  id: ArtifactId,
  threadId: ThreadId,
  taskId: Schema.optionalKey(TaskId),
  name: Schema.NonEmptyString,
  mimeType: Schema.NonEmptyString,
  size: Schema.Natural,
  path: Schema.NonEmptyString,
  createdAt: Timestamp,
})
export interface Artifact extends Schema.Schema.Type<typeof Artifact> {}

export const Bootstrap = Schema.Struct({
  devices: Schema.Array(Device),
  threads: Schema.Array(Thread),
  messages: Schema.Array(Message),
  tasks: Schema.Array(Task),
  artifacts: Schema.Array(Artifact),
})
export interface Bootstrap extends Schema.Schema.Type<typeof Bootstrap> {}

export const CreateThreadInput = Schema.Struct({
  title: Schema.NonEmptyString,
  defaultDeviceId: Schema.optionalKey(DeviceId),
})
export interface CreateThreadInput extends Schema.Schema.Type<typeof CreateThreadInput> {}

export const CreateMessageInput = Schema.Struct({
  content: Schema.NonEmptyString,
  role: Schema.optionalKey(MessageRole),
  kind: Schema.optionalKey(MessageKind),
  authorId: Schema.optionalKey(Schema.NonEmptyString),
  authorName: Schema.optionalKey(Schema.NonEmptyString),
  taskId: Schema.optionalKey(TaskId),
  replyTo: Schema.optionalKey(MessageId),
  deviceId: Schema.optionalKey(DeviceId),
})
export interface CreateMessageInput extends Schema.Schema.Type<typeof CreateMessageInput> {}

export const CreateTaskInput = Schema.Struct({
  threadId: Schema.optionalKey(ThreadId),
  title: Schema.optionalKey(Schema.NonEmptyString),
  prompt: Schema.NonEmptyString,
  context: Schema.optionalKey(Schema.String),
  provider: Schema.optionalKey(Provider),
  sourceDeviceId: Schema.optionalKey(DeviceId),
  targetDeviceId: Schema.optionalKey(DeviceId),
  parentTaskId: Schema.optionalKey(TaskId),
  workspace: Schema.optionalKey(Schema.String),
  wait: Schema.optionalKey(Schema.Boolean),
})
export interface CreateTaskInput extends Schema.Schema.Type<typeof CreateTaskInput> {}

export const ProviderEvent = Schema.TaggedUnion({
  SessionStarted: {
    sessionId: Schema.NonEmptyString,
  },
  AssistantMessage: {
    content: Schema.String,
  },
  Reasoning: {
    content: Schema.String,
  },
  ToolStarted: {
    tool: Schema.NonEmptyString,
    summary: Schema.String,
  },
  ToolCompleted: {
    tool: Schema.NonEmptyString,
    summary: Schema.String,
    success: Schema.Boolean,
  },
  CommandOutput: {
    content: Schema.String,
  },
  Usage: {
    inputTokens: Schema.Natural,
    outputTokens: Schema.Natural,
  },
})
export type ProviderEvent = typeof ProviderEvent.Type

export const SocketEvent = Schema.TaggedUnion({
  Connected: {
    serverVersion: Schema.NonEmptyString,
    connectedAt: Timestamp,
  },
  DeviceHello: {
    device: Device,
  },
  DeviceHeartbeat: {
    deviceId: DeviceId,
    status: DeviceStatus,
    sentAt: Timestamp,
  },
  TaskAssigned: {
    task: Task,
  },
  TaskAccepted: {
    taskId: TaskId,
    acceptedAt: Timestamp,
  },
  TaskProgress: {
    taskId: TaskId,
    event: ProviderEvent,
    sentAt: Timestamp,
  },
  TaskFinished: {
    taskId: TaskId,
    result: Schema.String,
    providerSessionId: Schema.optionalKey(Schema.String),
    finishedAt: Timestamp,
  },
  TaskFailed: {
    taskId: TaskId,
    error: Schema.NonEmptyString,
    finishedAt: Timestamp,
  },
  TaskCancelled: {
    taskId: TaskId,
    cancelledAt: Timestamp,
  },
  CancelTask: {
    taskId: TaskId,
  },
  DeviceChanged: {
    device: Device,
  },
  ThreadChanged: {
    thread: Thread,
  },
  MessageCreated: {
    message: Message,
  },
  TaskChanged: {
    task: Task,
  },
  ArtifactCreated: {
    artifact: Artifact,
  },
  Error: {
    code: Schema.NonEmptyString,
    message: Schema.NonEmptyString,
  },
})
export type SocketEvent = typeof SocketEvent.Type

export const ErrorResponse = Schema.Struct({
  error: Schema.NonEmptyString,
  detail: Schema.optionalKey(Schema.String),
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
export const makeArtifactId = (): ArtifactId => ArtifactId.make(crypto.randomUUID())

export const decodeBootstrap = Schema.decodeUnknownEffect(Bootstrap)
export const decodeCreateThreadInput = Schema.decodeUnknownEffect(CreateThreadInput)
export const decodeCreateMessageInput = Schema.decodeUnknownEffect(CreateMessageInput)
export const decodeCreateTaskInput = Schema.decodeUnknownEffect(CreateTaskInput)
export const decodeDevice = Schema.decodeUnknownEffect(Device)
export const decodeSocketEvent = Schema.decodeUnknownEffect(SocketEvent)
export const decodeTask = Schema.decodeUnknownEffect(Task)
