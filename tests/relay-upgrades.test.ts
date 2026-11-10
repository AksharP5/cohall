import { RelayClient } from "../packages/client/src/index.ts"
import { Device, makeDeviceId, now } from "../packages/protocol/src/index.ts"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { WebSocket } from "ws"

it("explains which legacy devices block an all-device upgrade", async () => {
  const reservation = createServer()
  reservation.listen(0, "127.0.0.1")
  await once(reservation, "listening")
  const address = reservation.address()
  if (address === null || typeof address === "string") throw new Error("Expected test port")
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  const directory = await mkdtemp(join(tmpdir(), "cohall-upgrades-"))
  const token = "legacy-upgrade-owned-test-token".padEnd(64, "0")
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
  let worker: WebSocket | undefined
  try {
    await vi.waitFor(async () => expect((await fetch(`${baseUrl}/api/health`)).ok).toBe(true), {
      timeout: 10_000,
    })
    const client = RelayClient.make({ baseUrl, token })
    worker = new WebSocket(`${baseUrl.replace("http", "ws")}/ws/device`)
    await once(worker, "open")
    const connected = once(worker, "message")
    worker.send(JSON.stringify({ _tag: "Authenticate", token }))
    await connected
    const device = Device.make({
      id: makeDeviceId(),
      name: "legacy-worker",
      hostname: "localhost",
      platform: "linux",
      architecture: "x64",
      status: "online",
      providers: ["codex"],
      capabilities: [],
      workspaces: [],
      version: "0.4.10",
      lastSeenAt: now(),
    })
    worker.send(JSON.stringify({ _tag: "DeviceHello", device }))
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.devices()))[0]?.status).toBe("online")
    })

    const error = await Effect.runPromise(
      Effect.flip(client.createUpgradeOperations({ target: "latest", restart: true })),
    )

    expect(error).toMatchObject({
      status: 409,
      message: expect.stringContaining("Upgrade individually first: legacy-worker (0.4.10)"),
    })
  } finally {
    worker?.terminate()
    relay.kill()
    await exited
    await rm(directory, { recursive: true, force: true })
  }
})
