import { RelayClient } from "../packages/client/src/index.ts"
import {
  Device,
  makeDeviceId,
  maxSocketPayloadBytes,
  now,
  version,
} from "../packages/protocol/src/index.ts"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { connect, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { WebSocket } from "ws"

it("isolates invalid connections and requeues work when a device connection fails", async () => {
  const reservation = createServer()
  reservation.listen(0, "127.0.0.1")
  await once(reservation, "listening")
  const address = reservation.address()
  if (address === null || typeof address === "string") throw new Error("Expected test port")
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  const directory = await mkdtemp(join(tmpdir(), "cohall-transport-"))
  const token = "transport-test-owner-token".padEnd(64, "0")
  const baseUrl = `http://127.0.0.1:${address.port}`
  const relay = spawn(process.execPath, ["apps/relay/src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      COHALL_RELAY_HOST: "127.0.0.1",
      COHALL_RELAY_PORT: String(address.port),
      COHALL_DATA_DIR: directory,
      COHALL_TOKEN: token,
    },
    stdio: "ignore",
  })
  const exited = once(relay, "exit")
  const sockets: Array<WebSocket> = []
  const client = RelayClient.make({ baseUrl, token })
  const openSocket = async () => {
    const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws/device`)
    sockets.push(socket)
    await once(socket, "open")
    return socket
  }
  const healthy = async () => {
    expect(relay.exitCode).toBeNull()
    expect((await fetch(`${baseUrl}/api/health`)).ok).toBe(true)
  }
  try {
    await vi.waitFor(healthy)

    const invalidUpgrade = connect(address.port, "127.0.0.1")
    let response = ""
    invalidUpgrade.on("data", (chunk) => {
      response += chunk.toString()
    })
    invalidUpgrade.write(
      "GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    )
    await once(invalidUpgrade, "close")
    expect(response).toMatch(/^HTTP\/1\.1 400 /)
    await healthy()

    const oversized = await openSocket()
    const oversizedClosed = once(oversized, "close")
    oversized.send(Buffer.alloc(maxSocketPayloadBytes + 1))
    await oversizedClosed
    await healthy()

    const device = Device.make({
      id: makeDeviceId(),
      name: "transport-device",
      hostname: "localhost",
      platform: "linux",
      architecture: "x64",
      providers: ["codex"],
      capabilities: [],
      workspaces: [],
      version,
      status: "online",
      lastSeenAt: now(),
    })
    const worker = await openSocket()
    const connected = once(worker, "message")
    worker.send(JSON.stringify({ _tag: "Authenticate", token }))
    await connected
    worker.send(JSON.stringify({ _tag: "DeviceHello", device }))
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.devices()))[0]?.status).toBe("online")
    })
    const task = await Effect.runPromise(
      client.createTask({ targetDeviceId: device.id, prompt: "Connection recovery" }),
    )
    expect(task.status).toBe("assigned")
    worker.send(JSON.stringify({ _tag: "TaskAccepted", taskId: task.id }))
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.getTask(task.id))).status).toBe("running")
    })
    const workerClosed = once(worker, "close")
    worker.send(Buffer.from([0xff]), { binary: false })
    await workerClosed
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.devices()))[0]?.status).toBe("offline")
      expect((await Effect.runPromise(client.getTask(task.id))).status).toBe("queued")
    })
    await healthy()
  } finally {
    for (const socket of sockets) socket.terminate()
    if (relay.exitCode === null) relay.kill("SIGKILL")
    await exited
    await rm(directory, { recursive: true, force: true })
  }
})
