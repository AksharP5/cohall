import { Bot, type Task } from "@cohall/protocol"
import { Effect, Schedule, Schema } from "effect"
import { open } from "node:fs/promises"
import { isIP } from "node:net"
import { claimBotDispatch, prepareBotReply, readBotReply } from "./bot-replies.ts"

const maxResponseBytes = 4 * 1024 * 1024
const maxDiscoveryBytes = 64 * 1024
const text = Schema.NonEmptyString
const Discovery = Schema.Struct({
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  host: Schema.optionalKey(text),
  scheme: Schema.optionalKey(Schema.Literals(["http", "https"])),
  token: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_384))),
})
const Agent = Schema.Struct({
  id: Bot.fields.id,
  name: Bot.fields.name,
  description: Schema.optionalKey(Schema.String),
  isGroup: Schema.optionalKey(Schema.Boolean),
})
const Roster = Schema.Array(Agent).check(Schema.isMaxLength(1024))
const Acceptance = Schema.Union([
  Schema.Struct({ outcome: Schema.Literals(["not-found", "unknown-durability"]) }),
  Schema.Struct({
    outcome: Schema.Literal("found"),
    record: Schema.Struct({
      status: Schema.Literals(["accepted", "pending", "rejected"]),
    }),
  }),
])
const SendResult = Schema.Struct({ accepted: Schema.Literal(true) })
class GatewayError extends Error {}

const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
  label: string,
): S["Type"] => {
  const result = Schema.decodeUnknownResult(schema)(value)
  if (result._tag === "Failure") throw new GatewayError(`Grok Bot returned an invalid ${label}`)
  return result.success
}

const readConnection = async (path: string) => {
  const value = await (async () => {
    const file = await open(path, "r")
    try {
      const buffer = Buffer.alloc(maxDiscoveryBytes + 1)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (bytesRead > maxDiscoveryBytes) throw new Error("Discovery file exceeds its size limit")
      return decode(
        Discovery,
        JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")),
        "discovery file",
      )
    } finally {
      await file.close()
    }
  })().catch(() => {
    throw new Error(
      "Cannot read Grok Bot gateway discovery; check its configured file and running gateway",
    )
  })
  const host = value.host ?? "127.0.0.1"
  const normalized =
    host === "0.0.0.0" || host === "localhost"
      ? "127.0.0.1"
      : host === "::" || host === "::1" || host === "[::1]"
        ? "[::1]"
        : host
  if (!(normalized === "[::1]" || (isIP(normalized) === 4 && normalized.startsWith("127.")))) {
    throw new Error("Grok Bot gateway must use a loopback address on this device")
  }
  return { url: `${value.scheme ?? "http"}://${normalized}:${value.port}`, token: value.token }
}

type Connection = Awaited<ReturnType<typeof readConnection>>

const rpc = async <S extends Schema.ConstraintDecoder<unknown>>(
  connection: Connection,
  method: string,
  args: object,
  schema: S,
  signal?: AbortSignal,
): Promise<S["Type"]> => {
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), 20_000)
  const combined =
    signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
  try {
    const response = await fetch(`${connection.url}/api/${method}`, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "x-sand-slim-avatars": "1",
        ...(connection.token === undefined || connection.token.length === 0
          ? {}
          : { authorization: `Bearer ${connection.token}` }),
      },
      body: JSON.stringify(args),
      signal: combined,
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new GatewayError(`Grok Bot ${method} failed (HTTP ${response.status})`)
    }
    if (response.body === null) throw new GatewayError("Grok Bot returned an empty response")
    const reader = response.body.getReader()
    const chunks: Array<Uint8Array> = []
    let size = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > maxResponseBytes) throw new GatewayError("Grok Bot response exceeded 4 MiB")
        chunks.push(chunk.value)
      }
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
    let json: unknown
    try {
      json = JSON.parse(Buffer.concat(chunks, size).toString("utf8"))
    } catch {
      throw new GatewayError(`Grok Bot ${method} returned invalid JSON`)
    }
    return decode(schema, json, `${method} response`)
  } catch (cause) {
    // Fetch errors and decoder failures can contain bearer tokens or private response bodies.
    if (signal?.aborted)
      throw new Error("Stopped waiting for Grok Bot; its run may still be active")
    if (cause instanceof GatewayError) throw cause
    throw new Error(`Grok Bot ${method} failed; check gateway availability and compatibility`)
  } finally {
    clearTimeout(deadline)
  }
}

export const discoverGrokBots = async (path: string): Promise<ReadonlyArray<Bot>> => {
  const connection = await readConnection(path)
  const roster = await rpc(connection, "listAgents", {}, Roster)
  const bots = roster.filter((agent) => agent.isGroup !== true)
  if (bots.length > 256) throw new Error("Grok Bot discovery exceeds Cohall's limit of 256 bots")
  if (new Set(bots.map((bot) => bot.id)).size !== bots.length) {
    throw new Error("Grok Bot returned duplicate bot identities")
  }
  return bots.map(({ id, name, description }) => ({
    id,
    name,
    ...(description === undefined ? {} : { description: description.slice(0, 512) }),
  }))
}

const poll = async <A>(pass: () => Promise<A | undefined>, signal: AbortSignal): Promise<A> => {
  const result = await Effect.runPromise(
    Effect.tryPromise({ try: pass, catch: (cause) => cause }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (value) => value !== undefined,
      }),
    ),
    { signal },
  )
  if (result === undefined) throw new Error("Grok Bot polling ended before a result")
  return result
}

const timeoutMessage =
  "Timed out waiting for the bot to reply through Cohall; the bot may still be running."

const requireTime = (deadline: number): void => {
  if (Date.now() >= deadline) throw new Error(timeoutMessage)
}

const finishReply = (
  reply: NonNullable<Awaited<ReturnType<typeof readBotReply>>>,
): { result: string } => {
  if (reply.error !== undefined) throw new Error(reply.error)
  if (reply.result === undefined) throw new Error("Grok Bot returned an invalid Cohall reply")
  return { result: reply.result }
}

const taskPrompt = (task: Task, command: string): string =>
  [
    task.prompt,
    task.context === undefined ? "" : `Context:\n${task.context}`,
    `This request came through Cohall. Thread: ${task.threadId}. Task: ${task.id}.`,
    `You may use your own tools and delegate work to another Cohall device when the request calls for it. Discover devices with: ${command} devices`,
    `Delegation example: ${command} delegate --thread ${task.threadId} --parent ${task.id} --target @device --provider codex --prompt 'Concrete task' --context 'Relevant context'`,
    "When finished, hand the final answer back to Cohall so it reaches the requesting device. Write it to a UTF-8 file on this computer, then run:",
    `${command} reply ${task.id} --message-file /absolute/path/to/your-answer.txt`,
    `Alternatively pipe your answer into: ${command} reply ${task.id} --message -`,
    `If you cannot complete this task, report the reason with: ${command} reply ${task.id} --error 'Reason'`,
    "The reply command must succeed. Then send the same answer in this chat. A normal chat message alone does not complete the Cohall task.",
  ]
    .filter(Boolean)
    .join("\n\n")

export const runGrokBot = async (
  path: string | undefined,
  task: Task,
  signal: AbortSignal,
): Promise<{ result: string }> => {
  const existing = await readBotReply(task.id)
  if (existing !== undefined) return finishReply(existing)
  const { deadline, command, dispatched } = await prepareBotReply(task)
  requireTime(deadline)
  const waitForReply = () =>
    poll(async () => {
      const receipt = await readBotReply(task.id)
      if (receipt !== undefined) return finishReply(receipt)
      requireTime(deadline)
      return undefined
    }, signal)
  if (dispatched) return waitForReply()
  if (path === undefined)
    throw new Error("Configure this device's Grok Bot gateway discovery file first")
  const agentId = task.botId
  if (agentId === undefined) throw new Error("Select a Grok Bot for this task")
  const connection = await readConnection(path)
  const lookup = () =>
    rpc(
      connection,
      "promptAcceptanceStatus",
      { accountSlot: "host", agentId, clientNonce: task.id },
      Acceptance,
      signal,
    )
  let acceptance = await lookup()
  if (acceptance.outcome === "unknown-durability")
    throw new Error(
      "Grok Bot cannot confirm whether this task was accepted; check its conversation before retrying",
    )
  if (acceptance.outcome === "not-found") {
    const receipt = await readBotReply(task.id)
    if (receipt !== undefined) return finishReply(receipt)
    requireTime(deadline)
    const roster = await rpc(connection, "listAgents", {}, Roster, signal)
    if (!roster.some((row) => row.id === agentId && row.isGroup !== true)) {
      throw new Error("The selected Grok Bot no longer exists on this device")
    }
    requireTime(deadline)
    acceptance = await lookup()
    if (acceptance.outcome === "not-found") {
      requireTime(deadline)
      if (!(await claimBotDispatch(task.id))) {
        return waitForReply()
      }
      try {
        await rpc(
          connection,
          "sendPrompt",
          {
            agentId,
            prompt: taskPrompt(task, command),
            clientNonce: task.id,
            directAddressedAcceptance: true,
          },
          SendResult,
          signal,
        )
      } catch {
        if (signal.aborted)
          throw new Error("Stopped waiting for Grok Bot; its run may still be active")
        const receipt = await readBotReply(task.id)
        if (receipt !== undefined) return finishReply(receipt)
        const reconciled = await lookup().catch(() => undefined)
        if (reconciled?.outcome === "found" && reconciled.record.status === "rejected")
          throw new Error("Grok Bot rejected this task; check its conversation")
        return waitForReply()
      }
    }
  }
  if (acceptance.outcome === "unknown-durability")
    throw new Error("Grok Bot cannot confirm task acceptance; the prompt was not resent")
  if (acceptance.outcome === "found" && acceptance.record.status === "rejected")
    throw new Error("Grok Bot rejected this task; check its conversation")
  return waitForReply()
}
