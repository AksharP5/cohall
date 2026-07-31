import {
  Artifact,
  AuthSession,
  Bootstrap,
  Device,
  Message,
  PairingCredential,
  PairingResult,
  Task,
  Thread,
  makeAuthSessionId,
  makeMessageId,
  makeTaskId,
  makeThreadId,
  now,
  type AuthSessionId,
  type ConnectionRole,
  type CreatePairingInput,
  type CreateMessageInput,
  type CreateTaskInput,
  type CreateThreadInput,
  type DeviceId,
  type TaskId,
  type TaskStatus,
  type ThreadId,
  type Timestamp,
} from "@cohall/protocol"
import { Database } from "bun:sqlite"
import { Context, Effect, Layer, Schema } from "effect"

export class PersistenceError extends Schema.TaggedErrorClass<PersistenceError>()(
  "RelayStore.PersistenceError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

interface ThreadRow {
  readonly id: string
  readonly title: string
  readonly created_at: string
  readonly updated_at: string
  readonly archived_at: string | null
  readonly default_device_id: string | null
}

interface MessageRow {
  readonly id: string
  readonly thread_id: string
  readonly role: string
  readonly kind: string
  readonly author_id: string
  readonly author_name: string
  readonly content: string
  readonly created_at: string
  readonly task_id: string | null
  readonly reply_to: string | null
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
  readonly capabilities_json: string
  readonly workspaces_json: string
  readonly version: string
  readonly last_seen_at: string
  readonly connected_at: string | null
}

interface TaskRow {
  readonly id: string
  readonly thread_id: string
  readonly prompt: string
  readonly context: string | null
  readonly provider: string
  readonly status: string
  readonly source_device_id: string | null
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
}

interface ArtifactRow {
  readonly id: string
  readonly thread_id: string
  readonly task_id: string | null
  readonly name: string
  readonly mime_type: string
  readonly size: number
  readonly path: string
  readonly created_at: string
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
  readonly bootstrap: () => Effect.Effect<Bootstrap, PersistenceError>
  readonly listDevices: () => Effect.Effect<ReadonlyArray<Device>, PersistenceError>
  readonly upsertDevice: (device: Device) => Effect.Effect<Device, PersistenceError>
  readonly markDeviceOffline: (deviceId: DeviceId) => Effect.Effect<Device, PersistenceError>
  readonly createThread: (input: CreateThreadInput) => Effect.Effect<Thread, PersistenceError>
  readonly getThread: (threadId: ThreadId) => Effect.Effect<Thread, PersistenceError>
  readonly createMessage: (
    threadId: ThreadId,
    input: CreateMessageInput,
  ) => Effect.Effect<Message, PersistenceError>
  readonly createTask: (
    input: CreateTaskInput,
    targetDeviceId: DeviceId,
    threadId: ThreadId,
  ) => Effect.Effect<Task, PersistenceError>
  readonly getTask: (taskId: TaskId) => Effect.Effect<Task, PersistenceError>
  readonly pendingTasksFor: (
    deviceId: DeviceId,
  ) => Effect.Effect<ReadonlyArray<Task>, PersistenceError>
  readonly requeueTasksFor: (
    deviceId: DeviceId,
  ) => Effect.Effect<ReadonlyArray<Task>, PersistenceError>
  readonly updateTask: (taskId: TaskId, update: TaskUpdate) => Effect.Effect<Task, PersistenceError>
  readonly sessionFor: (
    threadId: ThreadId,
    deviceId: DeviceId,
    provider: string,
  ) => Effect.Effect<string | undefined, PersistenceError>
  readonly saveSession: (
    threadId: ThreadId,
    deviceId: DeviceId,
    provider: string,
    sessionId: string,
  ) => Effect.Effect<void, PersistenceError>
  readonly createPairing: (
    input: CreatePairingInput,
  ) => Effect.Effect<PairingCredential, PersistenceError>
  readonly exchangePairing: (
    token: string,
    deviceId?: DeviceId,
  ) => Effect.Effect<PairingResult, PersistenceError>
  readonly authenticateSession: (
    token: string,
    role: ConnectionRole,
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

const parseJson = (value: string): unknown => JSON.parse(value)

const secret = (prefix: "pair" | "session"): string => {
  const value = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")
  return `cohall_${prefix}_${value}`
}

const tokenHash = (token: string): string =>
  new Bun.CryptoHasher("sha256").update(token).digest("hex")

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
    ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
    ...(row.default_device_id === null ? {} : { defaultDeviceId: row.default_device_id }),
  })

const messageFromRow = (row: MessageRow): Effect.Effect<Message, PersistenceError> =>
  decode("RelayStore.decodeMessage", Message, {
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    kind: row.kind,
    authorId: row.author_id,
    authorName: row.author_name,
    content: row.content,
    createdAt: row.created_at,
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    ...(row.reply_to === null ? {} : { replyTo: row.reply_to }),
    ...(row.device_id === null ? {} : { deviceId: row.device_id }),
  })

const deviceFromRow = (row: DeviceRow): Effect.Effect<Device, PersistenceError> =>
  Effect.gen(function* () {
    const providers = yield* Effect.try({
      try: () => parseJson(row.providers_json),
      catch: operationError("RelayStore.decodeDevice.providers"),
    })
    const capabilities = yield* Effect.try({
      try: () => parseJson(row.capabilities_json),
      catch: operationError("RelayStore.decodeDevice.capabilities"),
    })
    const workspaces = yield* Effect.try({
      try: () => parseJson(row.workspaces_json),
      catch: operationError("RelayStore.decodeDevice.workspaces"),
    })

    return yield* decode("RelayStore.decodeDevice", Device, {
      id: row.id,
      name: row.name,
      hostname: row.hostname,
      platform: row.platform,
      architecture: row.architecture,
      status: row.status,
      providers,
      capabilities,
      workspaces,
      version: row.version,
      lastSeenAt: row.last_seen_at,
      ...(row.connected_at === null ? {} : { connectedAt: row.connected_at }),
    })
  })

const taskFromRow = (row: TaskRow): Effect.Effect<Task, PersistenceError> =>
  decode("RelayStore.decodeTask", Task, {
    id: row.id,
    threadId: row.thread_id,
    prompt: row.prompt,
    provider: row.provider,
    status: row.status,
    targetDeviceId: row.target_device_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.context === null ? {} : { context: row.context }),
    ...(row.source_device_id === null ? {} : { sourceDeviceId: row.source_device_id }),
    ...(row.parent_task_id === null ? {} : { parentTaskId: row.parent_task_id }),
    ...(row.workspace === null ? {} : { workspace: row.workspace }),
    ...(row.provider_session_id === null ? {} : { providerSessionId: row.provider_session_id }),
    ...(row.result === null ? {} : { result: row.result }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
  })

const artifactFromRow = (row: ArtifactRow): Effect.Effect<Artifact, PersistenceError> =>
  decode("RelayStore.decodeArtifact", Artifact, {
    id: row.id,
    threadId: row.thread_id,
    name: row.name,
    mimeType: row.mime_type,
    size: row.size,
    path: row.path,
    createdAt: row.created_at,
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
  })

const authSessionFromRow = (row: AuthSessionRow): Effect.Effect<AuthSession, PersistenceError> =>
  Effect.gen(function* () {
    const roles = yield* Effect.try({
      try: () => parseJson(row.roles_json),
      catch: operationError("RelayStore.decodeAuthSession.roles"),
    })
    return yield* decode("RelayStore.decodeAuthSession", AuthSession, {
      id: row.id,
      label: row.label,
      roles,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastSeenAt: row.last_seen_at,
      ...(row.bound_device_id === null ? {} : { deviceId: row.bound_device_id }),
      ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    })
  })

const queryAll = <Row>(
  db: Database,
  operation: string,
  sql: string,
): Effect.Effect<ReadonlyArray<Row>, PersistenceError> =>
  Effect.try({
    try: () => db.query<Row, []>(sql).all(),
    catch: operationError(operation),
  })

const makeService = (db: Database): Interface => {
  const listDevices = Effect.fn("RelayStore.listDevices")(function* () {
    const rows = yield* queryAll<DeviceRow>(
      db,
      "RelayStore.listDevices",
      "SELECT * FROM devices ORDER BY name COLLATE NOCASE",
    )
    return yield* Effect.forEach(rows, deviceFromRow)
  })

  const listThreads = Effect.fn("RelayStore.listThreads")(function* () {
    const rows = yield* queryAll<ThreadRow>(
      db,
      "RelayStore.listThreads",
      "SELECT * FROM threads ORDER BY updated_at DESC",
    )
    return yield* Effect.forEach(rows, threadFromRow)
  })

  const listMessages = Effect.fn("RelayStore.listMessages")(function* () {
    const rows = yield* queryAll<MessageRow>(
      db,
      "RelayStore.listMessages",
      "SELECT * FROM messages ORDER BY created_at ASC",
    )
    return yield* Effect.forEach(rows, messageFromRow)
  })

  const listTasks = Effect.fn("RelayStore.listTasks")(function* () {
    const rows = yield* queryAll<TaskRow>(
      db,
      "RelayStore.listTasks",
      "SELECT * FROM tasks ORDER BY created_at ASC",
    )
    return yield* Effect.forEach(rows, taskFromRow)
  })

  const listArtifacts = Effect.fn("RelayStore.listArtifacts")(function* () {
    const rows = yield* queryAll<ArtifactRow>(
      db,
      "RelayStore.listArtifacts",
      "SELECT * FROM artifacts ORDER BY created_at ASC",
    )
    return yield* Effect.forEach(rows, artifactFromRow)
  })

  const bootstrap = Effect.fn("RelayStore.bootstrap")(function* () {
    const [devices, threads, messages, tasks, artifacts] = yield* Effect.all(
      [listDevices(), listThreads(), listMessages(), listTasks(), listArtifacts()],
      { concurrency: 5 },
    )
    return Bootstrap.make({ devices, threads, messages, tasks, artifacts })
  })

  const upsertDevice = Effect.fn("RelayStore.upsertDevice")(function* (device: Device) {
    yield* Effect.try({
      try: () =>
        db
          .query(
            `INSERT INTO devices (
              id, name, hostname, platform, architecture, status, providers_json,
              capabilities_json, workspaces_json, version, last_seen_at, connected_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              hostname = excluded.hostname,
              platform = excluded.platform,
              architecture = excluded.architecture,
              status = excluded.status,
              providers_json = excluded.providers_json,
              capabilities_json = excluded.capabilities_json,
              workspaces_json = excluded.workspaces_json,
              version = excluded.version,
              last_seen_at = excluded.last_seen_at,
              connected_at = excluded.connected_at`,
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
          ),
      catch: operationError("RelayStore.upsertDevice"),
    })
    return device
  })

  const markDeviceOffline = Effect.fn("RelayStore.markDeviceOffline")(function* (
    deviceId: DeviceId,
  ) {
    const seenAt = now()
    yield* Effect.try({
      try: () =>
        db
          .query("UPDATE devices SET status = 'offline', last_seen_at = ? WHERE id = ?")
          .run(seenAt, deviceId),
      catch: operationError("RelayStore.markDeviceOffline"),
    })
    const row = yield* Effect.try({
      try: () => db.query<DeviceRow, [string]>("SELECT * FROM devices WHERE id = ?").get(deviceId),
      catch: operationError("RelayStore.markDeviceOffline.read"),
    })
    if (row === null) {
      return yield* Effect.fail(
        new PersistenceError({
          operation: "RelayStore.markDeviceOffline",
          message: `Unknown device ${deviceId}`,
        }),
      )
    }
    return yield* deviceFromRow(row)
  })

  const createThread = Effect.fn("RelayStore.createThread")(function* (input: CreateThreadInput) {
    const timestamp = now()
    const thread = Thread.make({
      id: makeThreadId(),
      title: input.title,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(input.defaultDeviceId === undefined ? {} : { defaultDeviceId: input.defaultDeviceId }),
    })
    yield* Effect.try({
      try: () =>
        db
          .query(
            `INSERT INTO threads (
              id, title, created_at, updated_at, default_device_id
            ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            thread.id,
            thread.title,
            thread.createdAt,
            thread.updatedAt,
            thread.defaultDeviceId ?? null,
          ),
      catch: operationError("RelayStore.createThread"),
    })
    return thread
  })

  const getThread = Effect.fn("RelayStore.getThread")(function* (threadId: ThreadId) {
    const row = yield* Effect.try({
      try: () => db.query<ThreadRow, [string]>("SELECT * FROM threads WHERE id = ?").get(threadId),
      catch: operationError("RelayStore.getThread"),
    })
    if (row === null) {
      return yield* Effect.fail(
        new PersistenceError({
          operation: "RelayStore.getThread",
          message: `Unknown thread ${threadId}`,
        }),
      )
    }
    return yield* threadFromRow(row)
  })

  const createMessage = Effect.fn("RelayStore.createMessage")(function* (
    threadId: ThreadId,
    input: CreateMessageInput,
  ) {
    const timestamp = now()
    const message = Message.make({
      id: makeMessageId(),
      threadId,
      role: input.role ?? "human",
      kind: input.kind ?? "chat",
      authorId: input.authorId ?? "user",
      authorName: input.authorName ?? "You",
      content: input.content,
      createdAt: timestamp,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
      ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
    })
    yield* Effect.try({
      try: () =>
        db.transaction(() => {
          db.query(
            `INSERT INTO messages (
              id, thread_id, role, kind, author_id, author_name, content, created_at,
              task_id, reply_to, device_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            message.id,
            message.threadId,
            message.role,
            message.kind,
            message.authorId,
            message.authorName,
            message.content,
            message.createdAt,
            message.taskId ?? null,
            message.replyTo ?? null,
            message.deviceId ?? null,
          )
          db.query("UPDATE threads SET updated_at = ? WHERE id = ?").run(timestamp, threadId)
        })(),
      catch: operationError("RelayStore.createMessage"),
    })
    return message
  })

  const createTask = Effect.fn("RelayStore.createTask")(function* (
    input: CreateTaskInput,
    targetDeviceId: DeviceId,
    threadId: ThreadId,
  ) {
    const timestamp = now()
    const task = Task.make({
      id: makeTaskId(),
      threadId,
      prompt: input.prompt,
      provider: input.provider ?? "codex",
      status: "queued",
      targetDeviceId,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(input.context === undefined ? {} : { context: input.context }),
      ...(input.sourceDeviceId === undefined ? {} : { sourceDeviceId: input.sourceDeviceId }),
      ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
      ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
    })
    yield* Effect.try({
      try: () =>
        db
          .query(
            `INSERT INTO tasks (
              id, thread_id, prompt, context, provider, status, source_device_id,
              target_device_id, parent_task_id, workspace, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            task.id,
            task.threadId,
            task.prompt,
            task.context ?? null,
            task.provider,
            task.status,
            task.sourceDeviceId ?? null,
            task.targetDeviceId,
            task.parentTaskId ?? null,
            task.workspace ?? null,
            task.createdAt,
            task.updatedAt,
          ),
      catch: operationError("RelayStore.createTask"),
    })
    return task
  })

  const getTask = Effect.fn("RelayStore.getTask")(function* (taskId: TaskId) {
    const row = yield* Effect.try({
      try: () => db.query<TaskRow, [string]>("SELECT * FROM tasks WHERE id = ?").get(taskId),
      catch: operationError("RelayStore.getTask"),
    })
    if (row === null) {
      return yield* Effect.fail(
        new PersistenceError({
          operation: "RelayStore.getTask",
          message: `Unknown task ${taskId}`,
        }),
      )
    }
    return yield* taskFromRow(row)
  })

  const pendingTasksFor = Effect.fn("RelayStore.pendingTasksFor")(function* (deviceId: DeviceId) {
    const rows = yield* Effect.try({
      try: () =>
        db
          .query<TaskRow, [string]>(
            `SELECT * FROM tasks
             WHERE target_device_id = ? AND status IN ('queued', 'assigned')
             ORDER BY created_at ASC`,
          )
          .all(deviceId),
      catch: operationError("RelayStore.pendingTasksFor"),
    })
    return yield* Effect.forEach(rows, taskFromRow)
  })

  const requeueTasksFor = Effect.fn("RelayStore.requeueTasksFor")(function* (deviceId: DeviceId) {
    yield* Effect.try({
      try: () =>
        db
          .query(
            `UPDATE tasks SET status = 'queued', updated_at = ?
             WHERE target_device_id = ?
               AND status IN ('assigned', 'running', 'waiting')`,
          )
          .run(now(), deviceId),
      catch: operationError("RelayStore.requeueTasksFor"),
    })
    return yield* pendingTasksFor(deviceId)
  })

  const updateTask = Effect.fn("RelayStore.updateTask")(function* (
    taskId: TaskId,
    update: TaskUpdate,
  ) {
    const current = yield* getTask(taskId)
    const updatedAt = now()
    yield* Effect.try({
      try: () =>
        db
          .query(
            `UPDATE tasks SET
              status = ?,
              provider_session_id = ?,
              result = ?,
              error = ?,
              started_at = ?,
              completed_at = ?,
              updated_at = ?
            WHERE id = ?`,
          )
          .run(
            update.status ?? current.status,
            update.providerSessionId ?? current.providerSessionId ?? null,
            update.result ?? current.result ?? null,
            update.error ?? current.error ?? null,
            update.startedAt ?? current.startedAt ?? null,
            update.completedAt ?? current.completedAt ?? null,
            updatedAt,
            taskId,
          ),
      catch: operationError("RelayStore.updateTask"),
    })
    return yield* getTask(taskId)
  })

  const sessionFor = Effect.fn("RelayStore.sessionFor")(function* (
    threadId: ThreadId,
    deviceId: DeviceId,
    provider: string,
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

  const saveSession = Effect.fn("RelayStore.saveSession")(function* (
    threadId: ThreadId,
    deviceId: DeviceId,
    provider: string,
    sessionId: string,
  ) {
    yield* Effect.try({
      try: () =>
        db
          .query(
            `INSERT INTO provider_sessions (
              thread_id, device_id, provider, session_id, updated_at
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(thread_id, device_id, provider) DO UPDATE SET
              session_id = excluded.session_id,
              updated_at = excluded.updated_at`,
          )
          .run(threadId, deviceId, provider, sessionId, now()),
      catch: operationError("RelayStore.saveSession"),
    })
  })

  const createPairing = Effect.fn("RelayStore.createPairing")(function* (
    input: CreatePairingInput,
  ) {
    if (input.roles.length === 0) {
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
            `INSERT INTO auth_pairings (
              token_hash, label, roles_json, expires_at, created_at
            ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            tokenHash(token),
            input.label,
            JSON.stringify([...new Set(input.roles)]),
            expiresAt,
            now(),
          ),
      catch: operationError("RelayStore.createPairing"),
    })
    return yield* decode("RelayStore.createPairing.result", PairingCredential, {
      token,
      expiresAt,
    })
  })

  const exchangePairing = Effect.fn("RelayStore.exchangePairing")(function* (
    token: string,
    deviceId?: DeviceId,
  ) {
    const timestamp = now()
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000).toISOString()
    const sessionToken = secret("session")
    const sessionId = makeAuthSessionId()
    const row = yield* Effect.try({
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
          const roles: unknown = JSON.parse(pairing.roles_json)
          if (!Array.isArray(roles)) {
            throw new Error("Pairing credential has invalid roles")
          }
          if (roles.some((role) => role === "device") && deviceId === undefined) {
            throw new Error("A device ID is required for device pairing")
          }
          const result = db
            .query(
              `UPDATE auth_pairings SET used_at = ?
               WHERE token_hash = ? AND used_at IS NULL`,
            )
            .run(timestamp, pairing.token_hash)
          if (result.changes !== 1) {
            throw new Error("Pairing credential was already used")
          }
          db.query(
            `INSERT INTO auth_sessions (
              id, token_hash, label, roles_json, created_at, expires_at, last_seen_at,
              bound_device_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            sessionId,
            tokenHash(sessionToken),
            pairing.label,
            pairing.roles_json,
            timestamp,
            expiresAt,
            timestamp,
            deviceId ?? null,
          )
          return {
            id: sessionId,
            token_hash: tokenHash(sessionToken),
            label: pairing.label,
            roles_json: pairing.roles_json,
            created_at: timestamp,
            expires_at: expiresAt,
            last_seen_at: timestamp,
            bound_device_id: deviceId ?? null,
            revoked_at: null,
          } satisfies AuthSessionRow
        })(),
      catch: operationError("RelayStore.exchangePairing"),
    })
    const session = yield* authSessionFromRow(row)
    return PairingResult.make({ token: sessionToken, session })
  })

  const authenticateSession = Effect.fn("RelayStore.authenticateSession")(function* (
    token: string,
    role: ConnectionRole,
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
    if (row === null) {
      return undefined
    }
    const session = yield* authSessionFromRow(row)
    if (!session.roles.includes(role)) {
      return undefined
    }
    const lastSeenAt = now()
    yield* Effect.try({
      try: () =>
        db
          .query("UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?")
          .run(lastSeenAt, session.id),
      catch: operationError("RelayStore.authenticateSession.touch"),
    })
    return AuthSession.make({ ...session, lastSeenAt })
  })

  const listAuthSessions = Effect.fn("RelayStore.listAuthSessions")(function* () {
    const rows = yield* queryAll<AuthSessionRow>(
      db,
      "RelayStore.listAuthSessions",
      "SELECT * FROM auth_sessions ORDER BY created_at DESC",
    )
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
    const row = yield* Effect.try({
      try: () =>
        db
          .query<AuthSessionRow, [string]>("SELECT * FROM auth_sessions WHERE id = ?")
          .get(sessionId),
      catch: operationError("RelayStore.revokeAuthSession.read"),
    })
    if (row === null) {
      return yield* Effect.fail(
        new PersistenceError({
          operation: "RelayStore.revokeAuthSession",
          message: `Unknown session ${sessionId}`,
        }),
      )
    }
    return yield* authSessionFromRow(row)
  })

  return Service.of({
    bootstrap,
    listDevices,
    upsertDevice,
    markDeviceOffline,
    createThread,
    getThread,
    createMessage,
    createTask,
    getTask,
    pendingTasksFor,
    requeueTasksFor,
    updateTask,
    sessionFor,
    saveSession,
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
      db.exec(`
        CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          hostname TEXT NOT NULL,
          platform TEXT NOT NULL,
          architecture TEXT NOT NULL,
          status TEXT NOT NULL,
          providers_json TEXT NOT NULL,
          capabilities_json TEXT NOT NULL,
          workspaces_json TEXT NOT NULL,
          version TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          connected_at TEXT
        );

        CREATE TABLE IF NOT EXISTS threads (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT,
          default_device_id TEXT REFERENCES devices(id)
        );

        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'chat',
          author_id TEXT NOT NULL,
          author_name TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL,
          task_id TEXT,
          reply_to TEXT REFERENCES messages(id),
          device_id TEXT REFERENCES devices(id)
        );
        CREATE INDEX IF NOT EXISTS messages_thread_created
          ON messages(thread_id, created_at);

        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          prompt TEXT NOT NULL,
          context TEXT,
          provider TEXT NOT NULL,
          status TEXT NOT NULL,
          source_device_id TEXT REFERENCES devices(id),
          target_device_id TEXT NOT NULL REFERENCES devices(id),
          parent_task_id TEXT REFERENCES tasks(id),
          workspace TEXT,
          provider_session_id TEXT,
          result TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS tasks_thread_created
          ON tasks(thread_id, created_at);
        CREATE INDEX IF NOT EXISTS tasks_target_status
          ON tasks(target_device_id, status);

        CREATE TABLE IF NOT EXISTS provider_sessions (
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          session_id TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(thread_id, device_id, provider)
        );

        CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          task_id TEXT REFERENCES tasks(id),
          name TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size INTEGER NOT NULL,
          path TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS auth_pairings (
          token_hash TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          roles_json TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          used_at TEXT
        );
        CREATE INDEX IF NOT EXISTS auth_pairings_expires
          ON auth_pairings(expires_at);

        CREATE TABLE IF NOT EXISTS auth_sessions (
          id TEXT PRIMARY KEY,
          token_hash TEXT NOT NULL UNIQUE,
          label TEXT NOT NULL,
          roles_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          bound_device_id TEXT,
          revoked_at TEXT
        );
        CREATE INDEX IF NOT EXISTS auth_sessions_token
          ON auth_sessions(token_hash);
      `)
      const authSessionColumns = db
        .query<{ readonly name: string }, []>("PRAGMA table_info(auth_sessions)")
        .all()
      if (!authSessionColumns.some((column) => column.name === "bound_device_id")) {
        db.exec("ALTER TABLE auth_sessions ADD COLUMN bound_device_id TEXT")
      }
      if (!authSessionColumns.some((column) => column.name === "expires_at")) {
        db.exec("ALTER TABLE auth_sessions ADD COLUMN expires_at TEXT")
        db.query("UPDATE auth_sessions SET expires_at = ? WHERE expires_at IS NULL").run(
          new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000).toISOString(),
        )
      }
    },
    catch: operationError("RelayStore.migrate"),
  })

export const layer = (path: string) =>
  Layer.effect(
    Service,
    Effect.acquireRelease(
      Effect.try({
        try: () => new Database(path, { create: true }),
        catch: operationError("RelayStore.open"),
      }).pipe(Effect.tap(migrate)),
      (db) =>
        Effect.sync(() => {
          db.close()
        }),
    ).pipe(Effect.map(makeService)),
  )

export const layerFromDatabase = (db: Database) =>
  Layer.effect(Service, migrate(db).pipe(Effect.map(() => makeService(db))))

export * as RelayStore from "./store.ts"
