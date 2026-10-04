import { RelayClient, exchangePairing } from "@cohall/client"
import { Device, DeviceId, SocketEvent, now, version } from "@cohall/protocol"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:http"
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { WebSocket, WebSocketServer } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"
import { StoredConfiguration, readStoredConfiguration, writeStoredConfiguration } from "./config.ts"
import { backupRelay, restoreRelay, switchRelay } from "./relay-migration.ts"

const directories: Array<string> = []

const temporary = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-relay-migration-"))
  directories.push(directory)
  return directory
}

const restoreEnvironment = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = value
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe("relay migration", () => {
  it("backs up and restores relay state with its owner credential", async () => {
    const root = await temporary()
    const source = join(root, "source")
    const backup = join(root, "backup")
    const target = join(root, "target")
    await mkdir(source)
    const database = new DatabaseSync(join(source, "cohall.db"))
    database.exec("CREATE TABLE sample (value TEXT NOT NULL); INSERT INTO sample VALUES ('kept')")
    database.close()
    const token = "relay-owner-token".padEnd(64, "0")
    await writeFile(join(source, "owner-token"), `${token}\n`, { mode: 0o600 })
    const previousDataDirectory = process.env.COHALL_DATA_DIR
    const previousOwnerToken = process.env.COHALL_TOKEN
    delete process.env.COHALL_TOKEN

    try {
      process.env.COHALL_DATA_DIR = source
      const backedUp = await backupRelay(backup)
      expect(backedUp.warning).toContain("credentials")

      process.env.COHALL_DATA_DIR = target
      const restored = await restoreRelay(backup)
      expect(restored.data_directory).toBe(target)
      expect(await readFile(join(target, "owner-token"), "utf8")).toBe(`${token}\n`)
      await expect(readFile(join(target, "migration-manifest.json"), "utf8")).resolves.toContain(
        '"formatVersion": 1',
      )
      const restoredDatabase = new DatabaseSync(join(target, "cohall.db"), { readOnly: true })
      expect(restoredDatabase.prepare("SELECT value FROM sample").get()).toEqual({ value: "kept" })
      restoredDatabase.close()
    } finally {
      restoreEnvironment("COHALL_DATA_DIR", previousDataDirectory)
      restoreEnvironment("COHALL_TOKEN", previousOwnerToken)
    }
  })

  it("refuses to overwrite an existing relay data directory", async () => {
    const root = await temporary()
    const source = join(root, "source")
    const backup = join(root, "backup")
    const target = join(root, "target")
    await mkdir(source)
    const database = new DatabaseSync(join(source, "cohall.db"))
    database.exec("CREATE TABLE sample (value TEXT NOT NULL)")
    database.close()
    await writeFile(join(source, "owner-token"), `${"x".repeat(64)}\n`)
    const previousDataDirectory = process.env.COHALL_DATA_DIR

    try {
      process.env.COHALL_DATA_DIR = source
      await backupRelay(backup)
      await mkdir(target)
      process.env.COHALL_DATA_DIR = target
      await expect(restoreRelay(backup)).rejects.toThrow("already exists")
    } finally {
      restoreEnvironment("COHALL_DATA_DIR", previousDataDirectory)
    }
  })

  it.skipIf(process.platform === "win32")(
    "rejects unsafe backup parents before writing relay secrets",
    async () => {
      const root = await temporary()
      const source = join(root, "source")
      const shared = join(root, "shared")
      await Promise.all([mkdir(source), mkdir(shared)])
      await chmod(shared, 0o777)
      const database = new DatabaseSync(join(source, "cohall.db"))
      database.exec("CREATE TABLE sample (value TEXT NOT NULL)")
      database.close()
      await writeFile(join(source, "owner-token"), `${"x".repeat(64)}\n`)
      const previousDataDirectory = process.env.COHALL_DATA_DIR

      try {
        process.env.COHALL_DATA_DIR = source
        await expect(backupRelay(join(shared, "backup"))).rejects.toThrow(
          "must not be group- or world-writable",
        )
        await expect(readFile(join(shared, "backup", "owner-token"), "utf8")).rejects.toThrow()
      } finally {
        restoreEnvironment("COHALL_DATA_DIR", previousDataDirectory)
      }
    },
  )

  it.skipIf(process.platform === "win32")("rejects symlinked backup members", async () => {
    const root = await temporary()
    const source = join(root, "source")
    const backup = join(root, "backup")
    const target = join(root, "target")
    await mkdir(source)
    const database = new DatabaseSync(join(source, "cohall.db"))
    database.exec("CREATE TABLE sample (value TEXT NOT NULL)")
    database.close()
    await writeFile(join(source, "owner-token"), `${"x".repeat(64)}\n`)
    const previousDataDirectory = process.env.COHALL_DATA_DIR

    try {
      process.env.COHALL_DATA_DIR = source
      await backupRelay(backup)
      await rm(join(backup, "owner-token"))
      await symlink(join(source, "owner-token"), join(backup, "owner-token"))
      process.env.COHALL_DATA_DIR = target
      await expect(restoreRelay(backup)).rejects.toThrow("must be a regular file")
    } finally {
      restoreEnvironment("COHALL_DATA_DIR", previousDataDirectory)
    }
  })

  it("verifies both credentials before switching and restarting a device", async () => {
    const root = await temporary()
    const previous = {
      config: process.env.COHALL_CONFIG,
      relay: process.env.COHALL_RELAY_URL,
      clientToken: process.env.COHALL_CLIENT_TOKEN,
      deviceToken: process.env.COHALL_DEVICE_TOKEN,
    }
    process.env.COHALL_CONFIG = join(root, "config.json")
    delete process.env.COHALL_RELAY_URL
    delete process.env.COHALL_CLIENT_TOKEN
    delete process.env.COHALL_DEVICE_TOKEN
    const verified: Array<string> = []

    try {
      await writeStoredConfiguration(
        StoredConfiguration.make({
          version: 1,
          relayUrl: "https://old.example",
          deviceId: DeviceId.make("11111111-1111-4111-8111-111111111111"),
          deviceName: "workstation",
          workspaces: [root],
          clientToken: "client-token",
          deviceToken: "device-token",
        }),
      )
      const result = await switchRelay({
        relayUrl: "https://new.example/",
        restart: true,
        verifyClient: (relayUrl, token) => {
          verified.push(`client:${relayUrl}:${token}`)
          return Promise.resolve()
        },
        verifyDevice: (relayUrl, token) => {
          verified.push(`device:${relayUrl}:${token}`)
          return Promise.resolve()
        },
        restartService: () =>
          Promise.resolve({ running: true, restarted: true, service: "cohall-device.service" }),
      })

      expect(result).toMatchObject({
        updated: true,
        relay_url: "https://new.example",
        verified_roles: ["client", "device"],
        service: { running: true, restarted: true },
      })
      expect(verified).toEqual([
        "client:https://new.example:client-token",
        "device:https://new.example:device-token",
      ])
      await expect(readStoredConfiguration()).resolves.toMatchObject({
        relayUrl: "https://new.example",
        clientToken: "client-token",
        deviceToken: "device-token",
      })
    } finally {
      restoreEnvironment("COHALL_CONFIG", previous.config)
      restoreEnvironment("COHALL_RELAY_URL", previous.relay)
      restoreEnvironment("COHALL_CLIENT_TOKEN", previous.clientToken)
      restoreEnvironment("COHALL_DEVICE_TOKEN", previous.deviceToken)
    }
  })

  it.each(["restart failure", "--no-restart"])(
    "restarts a worker on the saved relay after %s",
    async (firstAttempt) => {
      const root = await temporary()
      const names = [
        "COHALL_CONFIG",
        "COHALL_RELAY_URL",
        "COHALL_CLIENT_TOKEN",
        "COHALL_DEVICE_TOKEN",
      ] as const
      const previous = new Map(names.map((name) => [name, process.env[name]]))
      for (const name of names) delete process.env[name]
      process.env.COHALL_CONFIG = join(root, "config.json")
      const events: Array<string> = []
      let attempts = 0

      try {
        await writeStoredConfiguration(
          StoredConfiguration.make({
            version: 1,
            relayUrl: "https://old.example",
            deviceId: DeviceId.make("11111111-1111-4111-8111-111111111111"),
            deviceName: "workstation",
            workspaces: [root],
            clientToken: "client-token",
            deviceToken: "device-token",
          }),
        )
        const options = {
          relayUrl: "https://new.example",
          restart: true,
          verifyClient: async () => {
            events.push("client verified")
          },
          verifyDevice: async () => {
            events.push("device verified")
          },
          restartService: async () => {
            events.push("restart")
            attempts += 1
            if (firstAttempt === "restart failure" && attempts === 1) {
              throw new Error("transient restart failure")
            }
            return { running: true, restarted: true, service: "cohall-device.service" }
          },
        }
        const first = await switchRelay({ ...options, restart: firstAttempt !== "--no-restart" })
        expect(first.updated).toBe(true)
        expect(first.service.restarted).toBe(false)
        if (firstAttempt === "restart failure") {
          expect(first.warning).toContain("transient restart failure")
        }
        await expect(readStoredConfiguration()).resolves.toMatchObject({
          relayUrl: options.relayUrl,
        })
        events.length = 0

        const retry = await switchRelay(options)
        expect(retry).toMatchObject({ updated: false, service: { running: true, restarted: true } })
        expect(retry.warning).toBeUndefined()
        expect(events).toEqual(["client verified", "device verified", "restart"])
        expect(attempts).toBe(firstAttempt === "restart failure" ? 2 : 1)
        events.length = 0

        await switchRelay({ ...options, restart: false })
        expect(events).toEqual(["client verified", "device verified"])
      } finally {
        for (const name of names) restoreEnvironment(name, previous.get(name))
      }
    },
  )

  it("leaves the current relay untouched when verification fails", async () => {
    const root = await temporary()
    const previousConfig = process.env.COHALL_CONFIG
    const previousRelay = process.env.COHALL_RELAY_URL
    process.env.COHALL_CONFIG = join(root, "config.json")
    delete process.env.COHALL_RELAY_URL

    try {
      await writeStoredConfiguration(
        StoredConfiguration.make({
          version: 1,
          relayUrl: "https://old.example",
          deviceId: DeviceId.make("11111111-1111-4111-8111-111111111111"),
          deviceName: "client",
          workspaces: [],
          clientToken: "client-token",
        }),
      )
      await expect(
        switchRelay({
          relayUrl: "https://broken.example",
          restart: true,
          verifyClient: () => Promise.reject(new Error("unauthorized")),
        }),
      ).rejects.toThrow("unauthorized")
      await expect(readStoredConfiguration()).resolves.toMatchObject({
        relayUrl: "https://old.example",
      })
    } finally {
      restoreEnvironment("COHALL_CONFIG", previousConfig)
      restoreEnvironment("COHALL_RELAY_URL", previousRelay)
    }
  })

  it("refuses remote HTTP before forwarding a stored credential", async () => {
    const root = await temporary()
    const previousConfig = process.env.COHALL_CONFIG
    const previousRelay = process.env.COHALL_RELAY_URL
    process.env.COHALL_CONFIG = join(root, "config.json")
    delete process.env.COHALL_RELAY_URL
    let verified = false

    try {
      await writeStoredConfiguration(
        StoredConfiguration.make({
          version: 1,
          relayUrl: "https://old.example",
          deviceId: DeviceId.make("11111111-1111-4111-8111-111111111111"),
          deviceName: "client",
          workspaces: [],
          clientToken: "client-token",
        }),
      )
      await expect(
        switchRelay({
          relayUrl: "http://relay.example",
          restart: false,
          verifyClient: () => {
            verified = true
            return Promise.resolve()
          },
        }),
      ).rejects.toThrow("Refusing to send stored credentials over remote HTTP")
      expect(verified).toBe(false)
      await expect(readStoredConfiguration()).resolves.toMatchObject({
        relayUrl: "https://old.example",
      })

      await expect(
        switchRelay({
          relayUrl: "http://relay.example",
          restart: false,
          allowHttp: true,
          verifyClient: () => {
            verified = true
            return Promise.resolve()
          },
        }),
      ).resolves.toMatchObject({ updated: true, relay_url: "http://relay.example" })
      expect(verified).toBe(true)
    } finally {
      restoreEnvironment("COHALL_CONFIG", previousConfig)
      restoreEnvironment("COHALL_RELAY_URL", previousRelay)
    }
  })

  it.each([401, 404])("verifies legacy device credentials after HTTP %s", async (status) => {
    const root = await temporary()
    const previousConfig = process.env.COHALL_CONFIG
    const previousRelay = process.env.COHALL_RELAY_URL
    process.env.COHALL_CONFIG = join(root, "config.json")
    delete process.env.COHALL_RELAY_URL
    const server = createServer((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "Legacy relay has no credential probe" }))
    })
    const sockets = new WebSocketServer({ noServer: true })
    let requestedPath: string | undefined
    server.on("upgrade", (request, socket, head) => {
      requestedPath = request.url
      sockets.handleUpgrade(request, socket, head, (websocket) => {
        sockets.emit("connection", websocket, request)
      })
    })
    sockets.on("connection", (socket) => {
      socket.once("message", () => {
        socket.send(
          JSON.stringify(
            SocketEvent.make({ _tag: "Connected", serverVersion: version, connectedAt: now() }),
          ),
        )
      })
    })

    try {
      await writeStoredConfiguration(
        StoredConfiguration.make({
          version: 1,
          relayUrl: "https://old.example",
          deviceId: DeviceId.make("11111111-1111-4111-8111-111111111111"),
          deviceName: "device",
          workspaces: [root],
          deviceToken: "device-token",
        }),
      )
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      const address = server.address()
      if (address === null || typeof address === "string") {
        throw new Error("Expected a TCP listener")
      }
      await expect(
        switchRelay({ relayUrl: `http://127.0.0.1:${address.port}`, restart: false }),
      ).resolves.toMatchObject({ updated: true, verified_roles: ["device"] })
      expect(requestedPath).toBe("/ws/device")
    } finally {
      for (const socket of sockets.clients) {
        socket.terminate()
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
      sockets.close()
      restoreEnvironment("COHALL_CONFIG", previousConfig)
      restoreEnvironment("COHALL_RELAY_URL", previousRelay)
    }
  })

  it("switches a connected worker's relay address without taking its credential connection", async () => {
    const root = await temporary()
    const reservation = createServer()
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve))
    const address = reservation.address()
    if (address === null || typeof address === "string") throw new Error("Expected test port")
    await new Promise<void>((resolve) => reservation.close(() => resolve()))
    const relayUrl = `http://127.0.0.1:${address.port}`
    const alias = `http://localhost:${address.port}`
    const ownerToken = "relay-switch-test-owner-token".padEnd(64, "0")
    const relay = spawn(process.execPath, ["bin/cohall.js", "relay"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        COHALL_RELAY_HOST: "127.0.0.1",
        COHALL_RELAY_PORT: String(address.port),
        COHALL_DATA_DIR: join(root, "relay"),
        COHALL_TOKEN: ownerToken,
      },
      stdio: "ignore",
    })
    const exited = once(relay, "exit")
    const owner = RelayClient.make({ baseUrl: relayUrl, token: ownerToken })
    const names = [
      "COHALL_CONFIG",
      "COHALL_RELAY_URL",
      "COHALL_CLIENT_TOKEN",
      "COHALL_DEVICE_TOKEN",
    ] as const
    const previous = new Map(names.map((name) => [name, process.env[name]]))
    let worker: WebSocket | undefined
    try {
      for (const name of names) delete process.env[name]
      process.env.COHALL_CONFIG = join(root, "config.json")
      await vi.waitFor(async () => expect((await fetch(`${relayUrl}/api/health`)).ok).toBe(true), {
        timeout: 10_000,
      })
      const invite = await Effect.runPromise(
        owner.createPairing({ label: "Switching worker", roles: ["client", "device"] }),
      )
      const paired = await Effect.runPromise(exchangePairing(relayUrl, { token: invite.token }))
      const clientCredential = paired.credentials.find((entry) => entry.session.role === "client")
      const deviceCredential = paired.credentials.find((entry) => entry.session.role === "device")
      const deviceId = deviceCredential?.session.deviceId
      if (
        clientCredential === undefined ||
        deviceCredential === undefined ||
        deviceId === undefined
      )
        throw new Error("Expected paired worker credentials")
      const configuration = StoredConfiguration.make({
        version: 1,
        relayUrl,
        deviceId,
        deviceName: "switching-worker",
        workspaces: [root],
        clientToken: clientCredential.token,
        deviceToken: deviceCredential.token,
      })
      await writeStoredConfiguration(configuration)
      worker = new WebSocket(`${relayUrl.replace("http", "ws")}/ws/device`)
      await once(worker, "open")
      const connected = once(worker, "message")
      worker.send(JSON.stringify({ _tag: "Authenticate", token: deviceCredential.token }))
      const [message] = await connected
      expect(JSON.parse(message.toString())._tag).toBe("Connected")
      worker.send(
        JSON.stringify({
          _tag: "DeviceHello",
          device: Device.make({
            id: deviceId,
            name: configuration.deviceName,
            hostname: "localhost",
            platform: "linux",
            architecture: process.arch,
            providers: ["codex"],
            capabilities: [],
            workspaces: [],
            version,
            status: "online",
            lastSeenAt: now(),
          }),
        }),
      )
      await vi.waitFor(async () => {
        expect((await Effect.runPromise(owner.devices()))[0]?.status).toBe("online")
      })
      await expect(switchRelay({ relayUrl, restart: false })).resolves.toMatchObject({
        updated: false,
        verified_roles: ["client", "device"],
      })
      await expect(switchRelay({ relayUrl: alias, restart: false })).resolves.toMatchObject({
        updated: true,
        relay_url: alias,
        verified_roles: ["client", "device"],
      })
      expect(worker.readyState).toBe(WebSocket.OPEN)
      expect((await Effect.runPromise(owner.devices()))[0]?.status).toBe("online")

      const probe = (token?: string) =>
        fetch(`${relayUrl}/api/device/credential`, {
          headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
        })
      expect((await probe(ownerToken)).status).toBe(200)
      expect((await probe()).status).toBe(401)
      expect((await probe(clientCredential.token)).status).toBe(401)
      await writeStoredConfiguration(
        StoredConfiguration.make({
          ...configuration,
          relayUrl: alias,
          deviceToken: clientCredential.token,
        }),
      )
      await expect(switchRelay({ relayUrl, restart: false })).rejects.toThrow()
      await expect(readStoredConfiguration()).resolves.toMatchObject({ relayUrl: alias })
      expect(worker.readyState).toBe(WebSocket.OPEN)

      const closed = once(worker, "close")
      await Effect.runPromise(owner.revokeAuthSession(deviceCredential.session.id))
      await closed
      expect((await probe(deviceCredential.token)).status).toBe(401)
      await writeStoredConfiguration(
        StoredConfiguration.make({ ...configuration, relayUrl: alias }),
      )
      await expect(switchRelay({ relayUrl, restart: false })).rejects.toThrow()
      await expect(readStoredConfiguration()).resolves.toMatchObject({ relayUrl: alias })
    } finally {
      worker?.terminate()
      if (relay.exitCode === null) relay.kill("SIGKILL")
      await exited
      for (const name of names) restoreEnvironment(name, previous.get(name))
    }
  })
})
