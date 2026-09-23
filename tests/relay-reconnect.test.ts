import { RelayClient } from "../packages/client/src/index.ts"
import {
  BotId,
  Device,
  SocketEvent,
  makeDeviceId,
  now,
  version,
} from "../packages/protocol/src/index.ts"
import { Effect, Schema } from "effect"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { WebSocket } from "ws"

it("restores running task slots before a queued upgrade when the device reconnects", async () => {
  const reservation = createServer()
  reservation.listen(0, "127.0.0.1")
  await once(reservation, "listening")
  const address = reservation.address()
  if (address === null || typeof address === "string") throw new Error("Expected test port")
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  const directory = await mkdtemp(join(tmpdir(), "cohall-reconnect-"))
  const token = "reconnect-test-owner-token".padEnd(64, "0")
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
  const sockets: Array<WebSocket> = []
  const botId = BotId.make("reconnecting-bot")
  const device = Device.make({
    id: makeDeviceId(),
    name: "reconnecting-device",
    hostname: "localhost",
    platform: "linux",
    architecture: "x64",
    providers: ["codex", "grok-bot"],
    bots: [{ id: botId, name: "Research" }],
    capabilities: [],
    workspaces: [],
    version,
    status: "online",
    lastSeenAt: now(),
  })
  const client = RelayClient.make({ baseUrl, token })
  const connect = async () => {
    const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws/device`)
    sockets.push(socket)
    const events: Array<SocketEvent> = []
    const send = (event: SocketEvent) => socket.send(JSON.stringify(event))
    socket.on("message", (message) => {
      const event = Schema.decodeUnknownSync(SocketEvent)(JSON.parse(message.toString()))
      events.push(event)
      if (event._tag === "Connected") send({ _tag: "DeviceHello", device })
    })
    await once(socket, "open")
    send({ _tag: "Authenticate", token })
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.devices()))[0]?.status).toBe("online")
    })
    return { socket, events, send }
  }
  try {
    await vi.waitFor(async () => {
      expect((await fetch(`${baseUrl}/api/health`)).ok).toBe(true)
    })
    const original = await connect()
    const bot = await Effect.runPromise(
      client.createTask({
        targetDeviceId: device.id,
        botId,
        prompt: "Delegate local work",
      }),
    )
    original.send({ _tag: "TaskAccepted", taskId: bot.id })
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.getTask(bot.id))).status).toBe("running")
    })
    const [upgrade] = await Effect.runPromise(
      client.createUpgradeOperations({ target: "latest", restart: true }),
    )
    if (upgrade === undefined) throw new Error("Expected queued upgrade")
    expect(upgrade.status).toBe("queued")
    const closed = once(original.socket, "close")
    original.socket.close()
    await closed
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.devices()))[0]?.status).toBe("offline")
    })

    const resumed = await connect()
    await vi.waitFor(() => {
      expect(
        resumed.events.some((event) => event._tag === "TaskAssigned" && event.task.id === bot.id),
      ).toBe(true)
    })
    expect(resumed.events.some((event) => event._tag === "OperationAssigned")).toBe(false)
    const child = await Effect.runPromise(
      client.createTask({
        targetDeviceId: device.id,
        provider: "codex",
        parentTaskId: bot.id,
        threadId: bot.threadId,
        prompt: "Local child work",
      }),
    )
    expect(child.status).toBe("assigned")
    const followup = await Effect.runPromise(
      client.createTask({
        targetDeviceId: device.id,
        botId,
        prompt: "Follow up after upgrade",
      }),
    )
    expect(followup.status).toBe("queued")
    resumed.send({ _tag: "TaskFinished", taskId: child.id, result: "Child done" })
    resumed.send({ _tag: "TaskFinished", taskId: bot.id, result: "Parent done" })
    await vi.waitFor(() => {
      expect(
        resumed.events.some(
          (event) => event._tag === "OperationAssigned" && event.operation.id === upgrade.id,
        ),
      ).toBe(true)
    })
    expect((await Effect.runPromise(client.getTask(followup.id))).status).toBe("queued")
    resumed.send({ _tag: "OperationFinished", operationId: upgrade.id, result: "Upgraded" })
    await vi.waitFor(() => {
      expect(
        resumed.events.some(
          (event) => event._tag === "TaskAssigned" && event.task.id === followup.id,
        ),
      ).toBe(true)
    })
  } finally {
    for (const socket of sockets) socket.terminate()
    const exited = once(relay, "exit", { signal: AbortSignal.timeout(2_000) })
    relay.kill("SIGTERM")
    await exited.catch(() => relay.kill("SIGKILL"))
    await rm(directory, { recursive: true, force: true })
  }
})
