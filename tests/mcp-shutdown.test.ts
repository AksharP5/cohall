import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { expect, it, vi } from "vitest"
import {
  Device,
  Task,
  makeDeviceId,
  makeTaskId,
  makeThreadId,
  now,
  version,
} from "../packages/protocol/src/index.ts"

it.each(["delegate", "wait_task"] as const)(
  "stops %s polling and exits when the MCP host closes stdin",
  async (tool) => {
    const directory = await mkdtemp(join(tmpdir(), "cohall-mcp-eof-"))
    const device = Device.make({
      id: makeDeviceId(),
      name: "eof-worker",
      hostname: "localhost",
      platform: "linux",
      architecture: "x64",
      status: "online",
      providers: ["codex"],
      capabilities: [],
      workspaces: [],
      version,
      lastSeenAt: now(),
    })
    const task = Task.make({
      id: makeTaskId(),
      threadId: makeThreadId(),
      targetDeviceId: device.id,
      provider: "codex",
      prompt: "Work that outlives its disconnected MCP host",
      status: "queued",
      createdAt: now(),
      updatedAt: now(),
    })
    const poll = Promise.withResolvers<ServerResponse>()
    const mutations: Array<string> = []
    let polls = 0
    const json = (response: ServerResponse, value: unknown) =>
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value))
    const relay = createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drain the real delegation request before responding.
      }
      if (request.url === "/api/devices") return void json(response, [device])
      if (request.url === "/api/tasks" && request.method === "POST")
        return void json(response, task)
      if (request.method !== "GET") mutations.push(`${request.method} ${request.url}`)
      if (request.url === `/api/tasks/${task.id}`) {
        polls += 1
        if (tool === "wait_task" && polls === 1) return void json(response, task)
        poll.resolve(response)
        return
      }
      response.writeHead(404).end()
    })
    relay.listen(0, "127.0.0.1")
    await once(relay, "listening")
    const address = relay.address()
    if (address === null || typeof address === "string") throw new Error("Expected relay port")
    const child = spawn(process.execPath, ["bin/cohall.js", "mcp"], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "",
        COHALL_CONFIG: join(directory, "client.json"),
        COHALL_RELAY_URL: `http://127.0.0.1:${address.port}`,
        COHALL_CLIENT_TOKEN: "synthetic-mcp-eof-token",
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const exited = once(child, "exit")
    const lines = createInterface({ input: child.stdout })
    let stderr = ""
    child.stderr.on("data", (chunk) => (stderr += chunk))
    const send = (message: object) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
    try {
      const initialized = once(lines, "line")
      send({
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "eof-test", version: "1.0.0" },
        },
      })
      expect(JSON.parse((await initialized)[0])).toMatchObject({ id: 1, result: {} })
      send({ method: "notifications/initialized" })
      send({
        id: 2,
        method: "tools/call",
        params: {
          name: tool,
          arguments:
            tool === "delegate"
              ? { target: "@eof-worker", prompt: task.prompt, timeout_seconds: 30 }
              : { task_id: task.id, timeout_seconds: 30 },
        },
      })
      const pending = await poll.promise
      child.stdin.end()
      await vi.waitFor(() => expect(pending.destroyed).toBe(true), { timeout: 2_000 })
      await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 2_000 })
      expect(await exited).toEqual([0, null])
      expect(pending.writableEnded).toBe(false)
      expect(mutations).toEqual([])
      expect(stderr).toBe("")
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
      await exited
      lines.close()
      relay.closeAllConnections()
      await new Promise<void>((resolve) => relay.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  },
)
