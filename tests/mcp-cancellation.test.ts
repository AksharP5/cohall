import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import {
  Device,
  Task,
  makeDeviceId,
  makeTaskId,
  makeThreadId,
  now,
  version,
} from "../packages/protocol/src/index.ts"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"

const withRelay = async (
  tool: "delegate" | "wait_task",
  test: (context: {
    readonly client: McpClient
    readonly task: Task
    readonly poll: Promise<ServerResponse>
    readonly complete: () => void
    readonly acknowledged: () => boolean
    readonly cancellations: () => number
  }) => Promise<void>,
) => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-mcp-cancel-"))
  const device = Device.make({
    id: makeDeviceId(),
    name: "cancel-worker",
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
    prompt: "Work that outlives the requester wait",
    status: "queued",
    createdAt: now(),
    updatedAt: now(),
  })
  const pending = Promise.withResolvers<ServerResponse>()
  let response: ServerResponse | undefined
  let acknowledged = false
  let completed = false
  let polls = 0
  let cancellations = 0
  const result = () => ({ ...task, status: "completed", result: "Finished", completedAt: now() })
  const inboxItem = () => ({
    id: task.id,
    threadId: task.threadId,
    targetDeviceId: task.targetDeviceId,
    provider: task.provider,
    status: "completed",
    promptPreview: task.prompt,
    completedAt: now(),
  })
  const json = (outgoing: ServerResponse, value: unknown) =>
    outgoing.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value))
  const relay = createServer(async (request, outgoing) => {
    for await (const _chunk of request) {
      // Drain request bodies before responding to the real client.
    }
    if (request.url === "/api/devices") return void json(outgoing, [device])
    if (request.url === "/api/tasks" && request.method === "POST") return void json(outgoing, task)
    if (request.url === `/api/tasks/${task.id}`) {
      polls += 1
      if (tool === "wait_task" && polls === 1) return void json(outgoing, task)
      response = outgoing
      pending.resolve(outgoing)
      return
    }
    if (request.url === `/api/inbox/${task.id}/ack`) {
      acknowledged = true
      return void json(outgoing, inboxItem())
    }
    if (request.url === "/api/inbox")
      return void json(outgoing, {
        items: completed && !acknowledged ? [inboxItem()] : [],
        hasMore: false,
      })
    if (request.url === `/api/tasks/${task.id}/cancel`) cancellations += 1
    outgoing.writeHead(404).end()
  })
  relay.listen(0, "127.0.0.1")
  await once(relay, "listening")
  const address = relay.address()
  if (address === null || typeof address === "string") throw new Error("Expected relay port")
  const client = new McpClient({ name: "cancellation-test", version: "1.0.0" })
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["bin/cohall.js", "mcp"],
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? "",
          COHALL_CONFIG: join(directory, "client.json"),
          COHALL_RELAY_URL: `http://127.0.0.1:${address.port}`,
          COHALL_CLIENT_TOKEN: "mcp-cancellation-test-token",
        },
        stderr: "ignore",
      }),
    )
    await test({
      client,
      task,
      poll: pending.promise,
      complete: () => {
        completed = true
        if (response !== undefined && !response.destroyed) json(response, result())
      },
      acknowledged: () => acknowledged,
      cancellations: () => cancellations,
    })
  } finally {
    await client.close()
    relay.closeAllConnections()
    await new Promise<void>((resolve) => relay.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}

it.each(["delegate", "wait_task"] as const)(
  "interrupts %s polling when its MCP caller cancels, preserving the completion inbox",
  async (tool) => {
    await withRelay(tool, async ({ client, task, poll, complete, acknowledged, cancellations }) => {
      const controller = new AbortController()
      const call = client.callTool(
        {
          name: tool,
          arguments:
            tool === "delegate"
              ? { target: "@cancel-worker", prompt: task.prompt, timeout_seconds: 5 }
              : { task_id: task.id, timeout_seconds: 5 },
        },
        undefined,
        { signal: controller.signal },
      )
      const rejected = expect(call).rejects.toThrow("Caller cancelled")
      const pending = await poll
      controller.abort(new Error("Caller cancelled"))
      await rejected
      await vi.waitFor(() => expect(pending.destroyed).toBe(true))
      expect(pending.writableEnded).toBe(false)
      complete()
      expect(acknowledged()).toBe(false)
      expect(cancellations()).toBe(0)
      expect(await client.callTool({ name: "completion_inbox", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: expect.stringContaining(task.id) }],
      })
    })
  },
)

it("still acknowledges a completed synchronous MCP delegation", async () => {
  await withRelay("delegate", async ({ client, task, poll, complete, acknowledged }) => {
    const call = client.callTool({
      name: "delegate",
      arguments: { target: "@cancel-worker", prompt: task.prompt, timeout_seconds: 5 },
    })
    await poll
    complete()
    expect(await call).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("Finished") }],
    })
    expect(acknowledged()).toBe(true)
  })
})
