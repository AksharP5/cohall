import { RelayClient, exchangePairing } from "../packages/client/src/index.ts"
import { Device, TaskProgress, now, version } from "../packages/protocol/src/index.ts"
import { Effect, Schema } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execa } from "execa"
import { expect, it, vi } from "vitest"
import { WebSocket } from "ws"

it("reports progress through CLI and MCP only for the authenticated target worker", async () => {
  const reservation = createServer()
  reservation.listen(0, "127.0.0.1")
  await once(reservation, "listening")
  const address = reservation.address()
  if (address === null || typeof address === "string") throw new Error("Missing test port")
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  const directory = await mkdtemp(join(tmpdir(), "cohall-progress-api-"))
  const token = "progress-test-owner-token".padEnd(64, "0")
  const relayUrl = `http://127.0.0.1:${address.port}`
  const relay = spawn(process.execPath, ["bin/cohall.js", "relay"], {
    env: {
      ...process.env,
      COHALL_CONFIG: join(directory, "missing.json"),
      COHALL_DATA_DIR: directory,
      COHALL_RELAY_HOST: "127.0.0.1",
      COHALL_RELAY_PORT: String(address.port),
      COHALL_TOKEN: token,
    },
    stdio: "ignore",
  })
  const exited = once(relay, "exit")
  const owner = RelayClient.make({ baseUrl: relayUrl, token })
  const mcp = new Client({ name: "progress-test", version: "1.0.0" })
  let socket: WebSocket | undefined
  try {
    await vi.waitFor(
      async () => {
        expect(relay.exitCode).toBeNull()
        expect((await fetch(`${relayUrl}/api/health`)).ok).toBe(true)
      },
      { timeout: 5_000 },
    )
    const pairing = await Effect.runPromise(
      owner.createPairing({ label: "Progress worker", roles: ["client", "device"] }),
    )
    const paired = await Effect.runPromise(exchangePairing(relayUrl, { token: pairing.token }))
    const clientCredential = paired.credentials.find(
      (credential) => credential.session.role === "client",
    )
    const deviceCredential = paired.credentials.find(
      (credential) => credential.session.role === "device",
    )
    const deviceId = deviceCredential?.session.deviceId
    if (clientCredential === undefined || deviceCredential === undefined || deviceId === undefined)
      throw new Error("Missing worker credentials")
    const device = Device.make({
      id: deviceId,
      name: "progress-worker",
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
    socket = new WebSocket(`${relayUrl.replace("http", "ws")}/ws/device`)
    await once(socket, "open")
    const connected = once(socket, "message")
    socket.send(JSON.stringify({ _tag: "Authenticate", token: deviceCredential.token }))
    await connected
    socket.send(JSON.stringify({ _tag: "DeviceHello", device }))
    await vi.waitFor(
      async () => {
        expect(
          (await Effect.runPromise(owner.devices())).some((item) => item.id === deviceId),
        ).toBe(true)
      },
      { timeout: 5_000 },
    )
    const assigned = once(socket, "message")
    const task = await Effect.runPromise(
      owner.createTask({ prompt: "Build", targetDeviceId: deviceId }),
    )
    await assigned
    socket.send(JSON.stringify({ _tag: "TaskAccepted", taskId: task.id }))
    await vi.waitFor(
      async () => {
        expect((await Effect.runPromise(owner.getTask(task.id))).status).toBe("running")
      },
      { timeout: 5_000 },
    )
    const environment = {
      COHALL_CONFIG: join(directory, "missing.json"),
      COHALL_RELAY_URL: relayUrl,
      COHALL_CLIENT_TOKEN: clientCredential.token,
      COHALL_TASK_ID: task.id,
    }
    const { stdout } = await execa(
      process.execPath,
      ["bin/cohall.js", "progress", "--message", "Running tests"],
      { env: environment },
    )
    const cliNote = Schema.decodeUnknownSync(TaskProgress)(JSON.parse(stdout))
    expect(cliNote.note).toBe("Running tests")
    expect((await Effect.runPromise(owner.traceTask(task.id))).progress).toEqual(cliNote)
    await mcp.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["bin/cohall.js", "mcp"],
        env: environment,
        stderr: "pipe",
      }),
    )
    const result = await mcp.callTool({
      name: "task_progress",
      arguments: { note: "Building package" },
    })
    expect(result.isError).not.toBe(true)
    const latest = (await Effect.runPromise(owner.getTask(task.id))).progress
    expect(latest?.note).toBe("Building package")

    const otherPairing = await Effect.runPromise(
      owner.createPairing({ label: "Other worker", roles: ["client", "device"] }),
    )
    const other = await Effect.runPromise(exchangePairing(relayUrl, { token: otherPairing.token }))
    const otherClient = other.credentials.find((credential) => credential.session.role === "client")
    if (otherClient === undefined) throw new Error("Missing other client")
    const post = (credential: string, note: string) =>
      fetch(`${relayUrl}/api/tasks/${task.id}/progress`, {
        method: "POST",
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
        body: JSON.stringify({ note }),
      })
    expect((await post(otherClient.token, "Wrong worker")).status).toBe(403)
    expect((await post(clientCredential.token, "😀".repeat(257))).status).toBe(400)
    expect((await Effect.runPromise(owner.getTask(task.id))).progress).toEqual(latest)
    socket.send(JSON.stringify({ _tag: "TaskFinished", taskId: task.id, result: "Done" }))
    await vi.waitFor(
      async () => {
        expect((await Effect.runPromise(owner.getTask(task.id))).status).toBe("completed")
      },
      { timeout: 5_000 },
    )
    expect((await post(deviceCredential.token, "Too late")).status).toBe(409)
  } finally {
    await mcp.close()
    socket?.terminate()
    relay.kill("SIGTERM")
    await exited
    await rm(directory, { recursive: true, force: true })
  }
})
