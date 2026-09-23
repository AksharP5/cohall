import { BotId, TaskId, ThreadId, type Task } from "@cohall/protocol"
import { Schema } from "effect"
import { randomUUID } from "node:crypto"
import { chmod, link, mkdir, open, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { platform } from "node:os"
import { configurationPath } from "./config.ts"

const replyLifetimeMs = 6 * 60 * 60 * 1_000
const Pending = Schema.Struct({
  taskId: TaskId,
  botId: BotId,
  threadId: ThreadId,
  deadline: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
const Dispatch = Schema.Struct({ taskId: TaskId })
const Reply = Schema.Union([
  Schema.Struct({
    result: Schema.String.check(Schema.isMaxLength(131_072)),
    error: Schema.optionalKey(Schema.Never),
  }),
  Schema.Struct({
    error: Schema.NonEmptyString.check(Schema.isMaxLength(16_384)),
    result: Schema.optionalKey(Schema.Never),
  }),
])
export type BotReply = typeof Reply.Type
const Receipt = Schema.Struct({
  taskId: TaskId,
  submittedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  reply: Reply,
})

const isMissing = (cause: unknown) =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT"
const alreadyExists = (cause: unknown) =>
  cause instanceof Error && "code" in cause && cause.code === "EEXIST"

const paths = (taskId: TaskId) => {
  const id = Schema.decodeUnknownSync(TaskId)(taskId)
  const directory = join(dirname(configurationPath()), "bot-replies")
  return {
    directory,
    pending: join(directory, `${id}.pending.json`),
    receipt: join(directory, `${id}.reply.json`),
    dispatch: join(directory, `${id}.dispatch.json`),
  }
}

const readJson = async (path: string, limit: number): Promise<unknown | undefined> => {
  const file = await open(path, "r").catch((cause: unknown) => {
    if (isMissing(cause)) return undefined
    throw cause
  })
  if (file === undefined) return undefined
  try {
    const buffer = Buffer.alloc(limit + 1)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size)
      if (bytesRead === 0) break
      size += bytesRead
    }
    if (size > limit) throw new Error("Bot reply record exceeds its size limit")
    return JSON.parse(buffer.subarray(0, size).toString("utf8"))
  } catch {
    throw new Error("Invalid local bot reply record")
  } finally {
    await file.close()
  }
}

const pendingReply = async (taskId: TaskId) => {
  const value = await readJson(paths(taskId).pending, 4096)
  if (value === undefined) return undefined
  const decoded = Schema.decodeUnknownResult(Pending)(value)
  if (decoded._tag === "Failure" || decoded.success.taskId !== taskId) {
    throw new Error("Invalid local bot reply manifest")
  }
  return decoded.success
}

const publish = async (path: string, value: object): Promise<boolean> => {
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, "wx", 0o600)
  try {
    try {
      await file.writeFile(`${JSON.stringify(value)}\n`, "utf8")
      await file.sync()
    } finally {
      await file.close()
    }
    await link(temporary, path)
    if (platform() !== "win32") {
      const directory = await open(dirname(path), "r")
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
    return true
  } catch (cause) {
    if (alreadyExists(cause)) return false
    throw cause
  } finally {
    await unlink(temporary)
  }
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export const prepareBotReply = async (
  task: Task,
): Promise<{ deadline: number; command: string; dispatched: boolean }> => {
  if (task.provider !== "grok-bot" || task.botId === undefined) {
    throw new Error("Only a named Grok Bot task can receive a bot reply")
  }
  const files = paths(task.id)
  await mkdir(files.directory, { recursive: true, mode: 0o700 })
  await chmod(files.directory, 0o700)
  const record = Pending.make({
    taskId: task.id,
    botId: task.botId,
    threadId: task.threadId,
    deadline: Date.now() + replyLifetimeMs,
  })
  await publish(files.pending, record)
  const pending = await pendingReply(task.id)
  if (pending === undefined || pending.botId !== task.botId || pending.threadId !== task.threadId) {
    throw new Error("Bot reply manifest does not match this task")
  }
  const dispatch = await readJson(files.dispatch, 4096)
  if (dispatch !== undefined) {
    const decoded = Schema.decodeUnknownResult(Dispatch)(dispatch)
    if (decoded._tag === "Failure" || decoded.success.taskId !== task.id) {
      throw new Error("Invalid local bot dispatch record")
    }
  }
  return {
    deadline: pending.deadline,
    command: `COHALL_CONFIG=${shellQuote(configurationPath())} cohall`,
    dispatched: dispatch !== undefined,
  }
}

export const claimBotDispatch = async (taskId: TaskId): Promise<boolean> => {
  const pending = await pendingReply(taskId)
  if (pending === undefined) throw new Error("No pending bot reply for this task")
  if (Date.now() >= pending.deadline) throw new Error("Bot reply deadline has expired")
  return publish(paths(taskId).dispatch, { taskId })
}

export const readBotReply = async (taskId: TaskId): Promise<BotReply | undefined> => {
  const pending = await pendingReply(taskId)
  if (pending === undefined) return undefined
  const value = await readJson(paths(taskId).receipt, 1024 * 1024)
  if (value === undefined) return undefined
  const decoded = Schema.decodeUnknownResult(Receipt)(value)
  if (decoded._tag === "Failure" || decoded.success.taskId !== taskId) {
    throw new Error("Invalid local bot reply receipt")
  }
  if (decoded.success.submittedAt >= pending.deadline) {
    throw new Error("Bot reply was submitted after its deadline")
  }
  return decoded.success.reply
}

export const writeBotReply = async (taskId: TaskId, reply: BotReply): Promise<void> => {
  const decoded = Schema.decodeUnknownResult(Reply)(reply)
  if (decoded._tag === "Failure") {
    throw new Error(
      "Provide a result of at most 131072 characters or a nonempty error of at most 16384 characters",
    )
  }
  const pending = await pendingReply(taskId)
  if (pending === undefined) throw new Error("No pending bot reply for this task")
  const existing = await readBotReply(taskId)
  if (existing !== undefined) {
    if (JSON.stringify(existing) === JSON.stringify(decoded.success)) return
    throw new Error("A different reply has already been submitted for this task")
  }
  const submittedAt = Date.now()
  if (submittedAt >= pending.deadline) throw new Error("Bot reply deadline has expired")
  if (await publish(paths(taskId).receipt, { taskId, submittedAt, reply: decoded.success })) return
  const winner = await readBotReply(taskId)
  if (JSON.stringify(winner) !== JSON.stringify(decoded.success)) {
    throw new Error("A different reply has already been submitted for this task")
  }
}

export const cleanupBotReply = async (taskId: TaskId): Promise<void> => {
  const files = paths(taskId)
  for (const path of [files.pending, files.receipt, files.dispatch]) {
    await unlink(path).catch((cause: unknown) => {
      if (!isMissing(cause)) throw cause
    })
  }
}
