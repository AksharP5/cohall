import { RelayClient, exchangePairing } from "../packages/client/src/index.ts"
import {
  Device,
  Task,
  TaskRequestId,
  makeDeviceId,
  now,
  version,
} from "../packages/protocol/src/index.ts"
import { RelayStore } from "../apps/relay/src/store.ts"
import { Effect, ManagedRuntime, Schema } from "effect"
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { expect, it, vi } from "vitest"

it("recovers an accepted task after a lost HTTP response and restart with its original requester", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-retry-"))
  const token = "retry-owner-token-that-is-at-least-thirty-two-characters"
  const target = Device.make({
    id: makeDeviceId(),
    name: "retry-target",
    hostname: "localhost",
    platform: "linux",
    architecture: "x64",
    status: "offline",
    providers: ["codex"],
    capabilities: [],
    workspaces: [],
    version,
    lastSeenAt: now(),
  })
  const seed = ManagedRuntime.make(RelayStore.layer(join(directory, "cohall.db")))
  await seed.runPromise(
    RelayStore.Service.pipe(Effect.flatMap((store) => store.upsertDevice(target))),
  )
  await seed.dispose()

  const reservation = createServer()
  reservation.listen(0, "127.0.0.1")
  await once(reservation, "listening")
  const address = reservation.address()
  if (address === null || typeof address === "string") throw new Error("Missing test port")
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  const relayUrl = `http://127.0.0.1:${address.port}`
  const start = () =>
    spawn("node", ["bin/cohall.js", "relay"], {
      cwd: process.cwd(),
      stdio: "ignore",
      env: {
        ...process.env,
        COHALL_DATA_DIR: directory,
        COHALL_TOKEN: token,
        COHALL_RELAY_PORT: String(address.port),
        COHALL_RELAY_HOST: "127.0.0.1",
      },
    })
  const stop = async (process: ChildProcess) => {
    if (process.exitCode !== null || process.signalCode !== null) return
    const exited = once(process, "exit")
    process.kill("SIGTERM")
    await exited
  }
  let relay = start()
  let accepted: Task | undefined
  let lost = false
  const proxy = createServer(async (request, response) => {
    const chunks: Array<Buffer> = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const upstream = await fetch(`${relayUrl}${request.url}`, {
      method: request.method ?? "GET",
      headers: {
        authorization: request.headers.authorization ?? "",
        "content-type": "application/json",
      },
      ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
    })
    const body = await upstream.text()
    if (request.url === "/api/tasks" && request.method === "POST" && !lost) {
      accepted = Schema.decodeUnknownSync(Task)(JSON.parse(body))
      lost = true
      response.destroy()
      return
    }
    response.writeHead(upstream.status, { "content-type": "application/json" }).end(body)
  })
  const mcp = new McpClient({ name: "retry-test", version: "1.0.0" })
  try {
    await vi.waitFor(async () => expect((await fetch(`${relayUrl}/api/health`)).ok).toBe(true), {
      timeout: 10_000,
    })
    proxy.listen(0, "127.0.0.1")
    await once(proxy, "listening")
    const proxyAddress = proxy.address()
    if (proxyAddress === null || typeof proxyAddress === "string")
      throw new Error("Missing proxy port")
    const owner = RelayClient.make({ baseUrl: relayUrl, token })
    const pair = async (label: string) => {
      const invite = await Effect.runPromise(owner.createPairing({ label, roles: ["client"] }))
      const joined = await Effect.runPromise(exchangePairing(relayUrl, { token: invite.token }))
      const credential = joined.credentials[0]
      if (credential === undefined) throw new Error("Missing client credential")
      return credential.token
    }
    const requesterToken = await pair("Sender")
    const otherToken = await pair("Other sender")
    const client = RelayClient.make({
      baseUrl: `http://127.0.0.1:${proxyAddress.port}`,
      token: requesterToken,
    })
    const other = RelayClient.make({ baseUrl: relayUrl, token: otherToken })
    const input = {
      requestId: TaskRequestId.make(crypto.randomUUID()),
      prompt: "Build",
      targetDeviceId: target.id,
    }
    await expect(Effect.runPromise(client.createTask(input))).rejects.toMatchObject({
      _tag: "RelayClient.RequestError",
    })
    if (accepted === undefined) throw new Error("Relay did not accept the lost request")
    const original = accepted
    expect((await Effect.runPromise(client.createTask(input))).id).toBe(original.id)
    const separate = await Effect.runPromise(
      other.createTask({ ...input, prompt: "Other sender work" }),
    )
    expect(separate.id).not.toBe(original.id)
    const ownerTask = await Effect.runPromise(owner.createTask(input))
    expect(ownerTask.id).not.toBe(original.id)
    for (const current of [original, separate, ownerTask])
      await Effect.runPromise(owner.cancelTask(current.id))
    await Effect.runPromise(owner.forgetDevice(target.id))
    await stop(relay)
    relay = start()
    await vi.waitFor(async () => expect((await fetch(`${relayUrl}/api/health`)).ok).toBe(true), {
      timeout: 10_000,
    })
    expect((await Effect.runPromise(client.createTask(input))).status).toBe("cancelled")
    await expect(
      Effect.runPromise(client.createTask({ ...input, prompt: "Changed" })),
    ).rejects.toMatchObject({ status: 409 })
    const environment = {
      ...process.env,
      COHALL_CONFIG: join(directory, "client.json"),
      COHALL_RELAY_URL: relayUrl,
      COHALL_CLIENT_TOKEN: requesterToken,
    }
    const cli = await promisify(execFile)(
      "node",
      [
        "bin/cohall.js",
        "send",
        `@${target.id}`,
        "Build",
        "--request-id",
        input.requestId,
        "--no-wait",
      ],
      { env: environment },
    )
    expect(JSON.parse(cli.stdout)).toMatchObject({ task_id: original.id, status: "cancelled" })
    await mcp.connect(
      new StdioClientTransport({
        command: "node",
        args: ["bin/cohall.js", "mcp"],
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? "",
          COHALL_CONFIG: environment.COHALL_CONFIG,
          COHALL_RELAY_URL: relayUrl,
          COHALL_CLIENT_TOKEN: requesterToken,
        },
        stderr: "ignore",
      }),
    )
    expect(
      await mcp.callTool({
        name: "delegate",
        arguments: {
          target: `@${target.id}`,
          prompt: "Build",
          request_id: input.requestId,
          wait: false,
        },
      }),
    ).toMatchObject({ content: [{ type: "text", text: expect.stringContaining(original.id) }] })
    const rejected = await fetch(`${relayUrl}/api/tasks`, {
      method: "POST",
      headers: { authorization: "Bearer invalid", "content-type": "application/json" },
      body: JSON.stringify(input),
    })
    expect(rejected.status).toBe(401)
    expect((await Effect.runPromise(client.threadContext(original.threadId))).tasks).toHaveLength(1)
  } finally {
    await mcp.close()
    proxy.closeAllConnections()
    await new Promise<void>((resolve) => proxy.close(() => resolve()))
    await stop(relay)
    await rm(directory, { recursive: true, force: true })
  }
})
