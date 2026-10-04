import { now, Timestamp, version } from "@cohall/protocol"
import type { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import type { RequestId } from "@modelcontextprotocol/sdk/types.js"
import { Schema } from "effect"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, opendir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { readBoundedFile } from "./bounded-file.ts"
import { configurationPath } from "./config.ts"

const maxRecords = 8
const maxRecordBytes = 4_096
const retentionMs = 7 * 24 * 60 * 60 * 1_000
const recordName = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}\.json$/
const text = Schema.String.check(Schema.isMaxLength(128))
const count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))

export const McpHostSession = Schema.Struct({
  schema_version: Schema.Literal(1),
  launch_id: Schema.String.check(Schema.isUUID(4)),
  launched_at: Timestamp,
  server_version: text,
  initialized_at: Schema.optionalKey(Timestamp),
  client: Schema.optionalKey(Schema.Struct({ name: text, version: text })),
  tools_list: Schema.optionalKey(Schema.Struct({ at: Timestamp, tool_count: count })),
  tools_call_count: count,
  last_tool_call_at: Schema.optionalKey(Timestamp),
  closed_at: Schema.optionalKey(Timestamp),
})
export interface McpHostSession extends Schema.Schema.Type<typeof McpHostSession> {}

export type McpHostDiagnostics = {
  readonly path: string
  readonly sessions: ReadonlyArray<McpHostSession>
  readonly warnings: ReadonlyArray<string>
} & (
  | { readonly status: "observed" | "not_observed" }
  | { readonly status: "unavailable"; readonly error: string }
)

const storagePath = (configPath: string): string => `${configPath}.mcp-hosts`

const recordsIn = async (directory: string) => {
  const records: Array<{ path: string; modified: number }> = []
  let entries = 0
  for await (const entry of await opendir(directory)) {
    if (++entries > 64) throw new Error("MCP host diagnostics directory exceeded its entry limit")
    if (!recordName.test(entry.name)) continue
    const path = join(directory, entry.name)
    const metadata = await lstat(path).catch((cause: unknown) => {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined
      throw cause
    })
    if (metadata !== undefined) records.push({ path, modified: metadata.mtimeMs })
  }
  return records.sort(
    (left, right) => right.modified - left.modified || left.path.localeCompare(right.path),
  )
}

export const readMcpHostDiagnostics = async (
  configPath = configurationPath(),
): Promise<McpHostDiagnostics> => {
  const path = storagePath(configPath)
  const warnings: Array<string> = []
  let records: Awaited<ReturnType<typeof recordsIn>>
  try {
    records = await recordsIn(path)
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return { status: "not_observed", path, sessions: [], warnings }
    }
    return {
      status: "unavailable",
      path,
      sessions: [],
      warnings,
      error: `Cannot read MCP host diagnostics at ${path}. Restore access to this diagnostics directory, then restart the Cohall MCP connection in your host.`,
    }
  }
  const sessions: Array<McpHostSession> = []
  let invalid = 0
  for (const record of records
    .filter((record) => record.modified >= Date.now() - retentionMs)
    .slice(0, maxRecords)) {
    try {
      const handle = await open(
        record.path,
        constants.O_RDONLY |
          (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
      )
      try {
        const metadata = await handle.stat()
        if (!metadata.isFile() || metadata.size > maxRecordBytes) throw new Error("Invalid record")
        const data = await readBoundedFile(handle, maxRecordBytes)
        if (data.length > maxRecordBytes) throw new Error("Invalid record")
        sessions.push(Schema.decodeUnknownSync(McpHostSession)(JSON.parse(data.toString("utf8"))))
      } finally {
        await handle.close()
      }
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) invalid += 1
    }
  }
  if (invalid > 0) {
    warnings.push(
      `${invalid} MCP host diagnostics record(s) could not be read. Reset the diagnostics directory ${path}, then restart the Cohall MCP connection in your host.`,
    )
  }
  if (sessions.length === 0 && invalid > 0) {
    return {
      status: "unavailable",
      path,
      sessions,
      warnings,
      error: "No valid MCP host diagnostics records could be read",
    }
  }
  const latest = sessions[0]
  if (latest !== undefined) {
    if (latest.initialized_at === undefined) {
      warnings.push(
        `${latest.closed_at === undefined ? "An MCP launch was recorded" : "A recorded MCP launch ended"} without client initialization. If your host still lacks Cohall tools, check its MCP command and selected config, then restart its Cohall connection.`,
      )
    } else if (latest.tools_list?.tool_count === 0) {
      warnings.push(
        "A recorded MCP launch returned an empty tools list. If Cohall tools are missing, check the host's Cohall MCP command and update or restart its connection.",
      )
    } else if (latest.tools_list === undefined && latest.tools_call_count === 0) {
      warnings.push(
        "An MCP host initialized Cohall but no tool discovery or calls were observed. If Cohall tools are missing, refresh or restart its MCP connection in that host.",
      )
    }
  }
  return {
    status: sessions.some((session) => session.initialized_at !== undefined)
      ? "observed"
      : "not_observed",
    path,
    sessions,
    warnings,
  }
}

export const createMcpHostDiagnostics = (server: Server): StdioServerTransport => {
  const transport = new StdioServerTransport()
  if (process.env.COHALL_MCP_SELF_TEST === "1") return transport
  const directory = storagePath(configurationPath())
  let session = McpHostSession.make({
    schema_version: 1,
    launch_id: randomUUID(),
    launched_at: now(),
    server_version: version,
    tools_call_count: 0,
  })
  const path = join(directory, `${session.launch_id}.json`)
  let dirty = true
  let disabled = false
  let stopped = false
  let writing: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const schedule = () => {
    if (disabled || stopped || timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      void flush()
    }, 250)
    timer.unref()
  }
  const flush = (): Promise<void> => {
    if (writing !== undefined) return writing
    if (!dirty || disabled) return Promise.resolve()
    dirty = false
    const snapshot = session
    writing = (async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await recordsIn(directory)
      const temporary = `${path}.tmp`
      try {
        const json = `${JSON.stringify(snapshot)}\n`
        if (Buffer.byteLength(json) > maxRecordBytes) throw new Error("Record exceeded its limit")
        await writeFile(temporary, json, { flag: "wx", mode: 0o600 })
        await rename(temporary, path)
      } finally {
        await rm(temporary, { force: true })
      }
      const records = await recordsIn(directory)
      const expired = records.filter(
        (record, index) => index >= maxRecords || record.modified < Date.now() - retentionMs,
      )
      await Promise.all(expired.map((record) => rm(record.path, { force: true })))
    })()
      .catch((cause: unknown) => {
        disabled = true
        const reason =
          cause instanceof Error
            ? "code" in cause && typeof cause.code === "string"
              ? cause.code
              : cause.message
            : "Unknown filesystem error"
        console.error(
          `Cohall MCP host diagnostics are unavailable (${reason.replace(/[\r\n]/g, " ").slice(0, 160)}). Check diagnostics storage access; MCP tools remain available.`,
        )
      })
      .finally(() => {
        writing = undefined
        if (dirty) schedule()
      })
    return writing
  }
  const changed = () => {
    dirty = true
    schedule()
  }
  const shutdown = async () => {
    if (stopped) return
    stopped = true
    clearTimeout(timer)
    session = { ...session, closed_at: now() }
    dirty = true
    await writing
    await flush()
  }
  void flush()
  process.once("beforeExit", () => void shutdown())
  const initialized = server.oninitialized
  server.oninitialized = () => {
    initialized?.()
    const client = server.getClientVersion()
    session = {
      ...session,
      initialized_at: now(),
      ...(client === undefined
        ? {}
        : { client: { name: client.name.slice(0, 128), version: client.version.slice(0, 128) } }),
    }
    changed()
  }
  const closed = server.onclose
  server.onclose = () => {
    closed?.()
    void shutdown()
  }
  const pendingLists = new Set<RequestId>()
  const start = transport.start.bind(transport)
  transport.start = async () => {
    const receive = transport.onmessage
    transport.onmessage = (message) => {
      if ("id" in message && message.id !== undefined && "method" in message) {
        if (message.method === "tools/list" && pendingLists.size < 32) pendingLists.add(message.id)
        if (message.method === "tools/call") {
          session = {
            ...session,
            tools_call_count: Math.min(session.tools_call_count + 1, Number.MAX_SAFE_INTEGER),
            last_tool_call_at: now(),
          }
          changed()
        }
      }
      receive?.(message)
    }
    await start()
  }
  const send = transport.send.bind(transport)
  transport.send = async (message) => {
    await send(message)
    if (
      "id" in message &&
      message.id !== undefined &&
      pendingLists.delete(message.id) &&
      "result" in message &&
      Array.isArray(message.result.tools)
    ) {
      session = { ...session, tools_list: { at: now(), tool_count: message.result.tools.length } }
      changed()
    }
  }
  return transport
}
