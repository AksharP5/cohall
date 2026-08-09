import {
  DeviceConfiguration,
  StoredConfiguration,
  credentialsForRelay,
  loadClientConfiguration,
  loadDeviceConfiguration,
  loadOwnerConfiguration,
  writeStoredConfiguration,
} from "./config.ts"
import { allowedWorkspace, openAllowedWorkspace, selectProviders } from "./daemon.ts"
import { DeviceId } from "@cohall/protocol"
import { Effect } from "effect"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { parseProviders, parseWorkspaces } from "./config.ts"

const directories: Array<string> = []

const temporary = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-config-"))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe("device workspace configuration", () => {
  it("retains credentials only for their issuing relay", () => {
    const configuration = StoredConfiguration.make({
      version: 1,
      relayUrl: "https://old-relay.example",
      deviceId: DeviceId.make("11111111-1111-4111-8111-111111111111"),
      deviceName: "test",
      workspaces: ["/workspace"],
      clientToken: "client-secret",
      deviceToken: "device-secret",
    })

    expect(credentialsForRelay(configuration, "https://old-relay.example/")).toEqual({
      clientToken: "client-secret",
      deviceToken: "device-secret",
    })
    expect(credentialsForRelay(configuration, "https://new-relay.example")).toEqual({})
  })

  it("requires explicit credentials when the environment changes relays", async () => {
    const directory = await temporary()
    const previous = {
      config: process.env.COHALL_CONFIG,
      relay: process.env.COHALL_RELAY_URL,
      clientToken: process.env.COHALL_CLIENT_TOKEN,
      deviceToken: process.env.COHALL_DEVICE_TOKEN,
    }
    process.env.COHALL_CONFIG = join(directory, "config.json")
    process.env.COHALL_RELAY_URL = "https://new-relay.example"
    delete process.env.COHALL_CLIENT_TOKEN
    delete process.env.COHALL_DEVICE_TOKEN

    try {
      await writeStoredConfiguration(
        StoredConfiguration.make({
          version: 1,
          relayUrl: "https://old-relay.example",
          deviceId: DeviceId.make("11111111-1111-4111-8111-111111111111"),
          deviceName: "test",
          workspaces: [directory],
          clientToken: "old-client-secret",
          deviceToken: "old-device-secret",
        }),
      )

      await expect(Effect.runPromise(loadClientConfiguration)).rejects.toThrow(
        "No client credential",
      )
      await expect(Effect.runPromise(loadDeviceConfiguration)).rejects.toThrow(
        "No device credential",
      )

      process.env.COHALL_CLIENT_TOKEN = "new-client-secret"
      process.env.COHALL_DEVICE_TOKEN = "new-device-secret"
      await expect(Effect.runPromise(loadClientConfiguration)).resolves.toMatchObject({
        relayUrl: "https://new-relay.example",
        token: "new-client-secret",
      })
      await expect(Effect.runPromise(loadDeviceConfiguration)).resolves.toMatchObject({
        relayUrl: "https://new-relay.example",
        token: "new-device-secret",
      })
    } finally {
      const restore = (name: string, value: string | undefined): void => {
        if (value === undefined) {
          delete process.env[name]
          return
        }
        process.env[name] = value
      }
      restore("COHALL_CONFIG", previous.config)
      restore("COHALL_RELAY_URL", previous.relay)
      restore("COHALL_CLIENT_TOKEN", previous.clientToken)
      restore("COHALL_DEVICE_TOKEN", previous.deviceToken)
    }
  })

  it("uses the relay host's protected owner credential", async () => {
    const directory = await temporary()
    const dataDirectory = join(directory, "relay")
    const ownerToken = "local-owner-token".padEnd(64, "0")
    await mkdir(dataDirectory)
    await writeFile(join(dataDirectory, "owner-token"), `${ownerToken}\n`, { mode: 0o600 })
    const previous = {
      config: process.env.COHALL_CONFIG,
      dataDirectory: process.env.COHALL_DATA_DIR,
      ownerToken: process.env.COHALL_TOKEN,
    }
    process.env.COHALL_CONFIG = join(directory, "config.json")
    process.env.COHALL_DATA_DIR = dataDirectory
    delete process.env.COHALL_TOKEN

    try {
      await expect(Effect.runPromise(loadOwnerConfiguration)).resolves.toMatchObject({
        token: ownerToken,
      })
    } finally {
      const restore = (name: string, value: string | undefined): void => {
        if (value === undefined) {
          delete process.env[name]
          return
        }
        process.env[name] = value
      }
      restore("COHALL_CONFIG", previous.config)
      restore("COHALL_DATA_DIR", previous.dataDirectory)
      restore("COHALL_TOKEN", previous.ownerToken)
    }
  })

  it("normalizes provider allowlists and advertises only installed selections", () => {
    expect(parseProviders("codex, opencode, codex")).toEqual(["codex", "opencode"])
    expect(() => parseProviders("codex,missing")).toThrow()
    expect(selectProviders(["codex", "opencode"], ["claude-code", "codex"])).toEqual(["codex"])
    expect(selectProviders(["codex", "opencode"])).toEqual(["codex", "opencode"])
  })

  it("canonicalizes existing roots and preserves commas in JSON paths", async () => {
    const directory = await temporary()
    const first = join(directory, "cohall,primary")
    const second = join(directory, "cohall-secondary")
    await Promise.all([mkdir(first), mkdir(second)])
    expect(
      await Effect.runPromise(parseWorkspaces("", JSON.stringify([first, second, first]))),
    ).toEqual([first, second])
  })

  it("rejects a symlink that escapes an allowed workspace", async () => {
    const directory = await temporary()
    const root = join(directory, "root")
    const outside = join(directory, "outside")
    await Promise.all([mkdir(root), mkdir(outside)])
    const escape = join(root, "escape")
    await symlink(outside, escape)
    const configuration = DeviceConfiguration.make({
      relayUrl: "http://127.0.0.1:8787",
      token: "test",
      id: DeviceId.make("11111111-1111-4111-8111-111111111111"),
      name: "test",
      workspaces: [root],
    })
    await expect(allowedWorkspace(configuration, escape)).rejects.toThrow("outside")
    await expect(allowedWorkspace(configuration, root)).resolves.toBe(root)
  })

  it("anchors provider startup to the authorized workspace directory", async () => {
    const directory = await temporary()
    const workspace = join(directory, "workspace")
    const moved = join(directory, "moved")
    const outside = join(directory, "outside")
    await Promise.all([mkdir(workspace), mkdir(outside)])
    await writeFile(join(workspace, "marker"), "authorized")
    const configuration = DeviceConfiguration.make({
      relayUrl: "http://127.0.0.1:8787",
      token: "test",
      id: DeviceId.make("11111111-1111-4111-8111-111111111111"),
      name: "test",
      workspaces: [directory],
    })
    const authorized = await openAllowedWorkspace(configuration, workspace)
    try {
      await rename(workspace, moved)
      await symlink(outside, workspace)
      await authorized.validate()
      const result = await promisify(execFile)(
        process.execPath,
        ["-e", 'process.stdout.write(require("node:fs").readFileSync("marker", "utf8"))'],
        { cwd: authorized.cwd },
      )
      expect(result.stdout).toBe("authorized")
    } finally {
      await authorized.close()
    }
  })
})
