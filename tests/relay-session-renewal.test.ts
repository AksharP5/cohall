import { Database } from "../apps/relay/src/database.ts"
import { RelayClient, exchangePairing } from "../packages/client/src/index.ts"
import { Device, now, version } from "../packages/protocol/src/index.ts"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { WebSocket } from "ws"

it("renews HTTP clients and connected workers while retaining expiry and revocation guards", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-session-renewal-"))
  const reservation = createServer()
  const sockets: Array<WebSocket> = []
  let relay: ReturnType<typeof spawn> | undefined
  let database: Database | undefined
  try {
    reservation.listen(0, "127.0.0.1")
    await once(reservation, "listening")
    const address = reservation.address()
    if (address === null || typeof address === "string") throw new Error("Expected test port")
    await new Promise<void>((resolve) => reservation.close(() => resolve()))
    const token = "session-renewal-owner-token".padEnd(64, "0")
    const baseUrl = `http://127.0.0.1:${address.port}`
    relay = spawn(process.execPath, ["apps/relay/src/main.ts"], {
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
    await vi.waitFor(async () => expect((await fetch(`${baseUrl}/api/health`)).ok).toBe(true), {
      timeout: 10_000,
    })
    const owner = RelayClient.make({ baseUrl, token })
    const invite = await Effect.runPromise(
      owner.createPairing({ label: "Worker", roles: ["client", "device"] }),
    )
    const paired = await Effect.runPromise(exchangePairing(baseUrl, { token: invite.token }))
    const client = paired.credentials.find(({ session }) => session.role === "client")
    const worker = paired.credentials.find(({ session }) => session.role === "device")
    if (client === undefined || worker?.session.deviceId === undefined) {
      throw new Error("Expected paired credentials and device identity")
    }
    const requester = RelayClient.make({ baseUrl, token: client.token })
    database = new Database(join(directory, "cohall.db"))
    const nearExpiry = new Date(Date.now() + 60_000).toISOString()
    database
      .query("UPDATE auth_sessions SET expires_at = ? WHERE id = ?")
      .run(nearExpiry, client.session.id)
    await Effect.runPromise(requester.devices())
    const renewedClient = (await Effect.runPromise(owner.authSessions())).find(
      ({ id }) => id === client.session.id,
    )
    expect(renewedClient).toMatchObject({
      id: client.session.id,
      deviceId: worker.session.deviceId,
      createdAt: client.session.createdAt,
    })
    expect(Date.parse(renewedClient?.expiresAt ?? "")).toBeGreaterThan(Date.parse(nearExpiry))

    const device = Device.make({
      id: worker.session.deviceId,
      name: "renewal-worker",
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
    const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws/device`)
    sockets.push(socket)
    await once(socket, "open")
    const connected = once(socket, "message")
    socket.send(JSON.stringify({ _tag: "Authenticate", token: worker.token }))
    const [message] = await connected
    expect(JSON.parse(String(message))).toMatchObject({ _tag: "Connected" })
    socket.send(JSON.stringify({ _tag: "DeviceHello", device }))
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(owner.devices()))[0]?.status).toBe("online")
    })
    database
      .query("UPDATE auth_sessions SET expires_at = ? WHERE id = ?")
      .run(nearExpiry, worker.session.id)
    socket.send(JSON.stringify({ _tag: "DeviceHeartbeat", deviceId: device.id, status: "busy" }))
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(owner.devices()))[0]?.status).toBe("busy")
    })
    const renewedWorker = (await Effect.runPromise(owner.authSessions())).find(
      ({ id }) => id === worker.session.id,
    )
    expect(renewedWorker?.deviceId).toBe(device.id)
    expect(Date.parse(renewedWorker?.expiresAt ?? "")).toBeGreaterThan(Date.parse(nearExpiry))
    const closed = once(socket, "close")
    await Effect.runPromise(owner.revokeAuthSession(worker.session.id))
    const [code] = await closed
    expect(code).toBe(4003)

    const rejected = new WebSocket(`${baseUrl.replace("http", "ws")}/ws/device`)
    sockets.push(rejected)
    await once(rejected, "open")
    const rejectedClose = once(rejected, "close")
    rejected.send(JSON.stringify({ _tag: "Authenticate", token: worker.token }))
    const [rejectedCode] = await rejectedClose
    expect(rejectedCode).toBe(4003)

    database
      .query("UPDATE auth_sessions SET expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", client.session.id)
    await expect(Effect.runPromise(requester.devices())).rejects.toMatchObject({ status: 401 })
  } finally {
    for (const socket of sockets) socket.terminate()
    database?.close()
    if (relay !== undefined && relay.exitCode === null) {
      const exited = once(relay, "exit")
      relay.kill("SIGTERM")
      await exited
    }
    await rm(directory, { recursive: true, force: true })
  }
})
