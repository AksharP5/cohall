import { DeviceId } from "@cohall/protocol"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
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
})
