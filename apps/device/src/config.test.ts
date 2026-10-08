import {
  DeviceConfiguration,
  StoredConfiguration,
  configurationPath,
  credentialsForRelay,
  loadClientConfiguration,
  loadDeviceConfiguration,
  loadOwnerConfiguration,
  makeStoredConfiguration,
  relayDataDirectory,
  writeStoredConfiguration,
} from "./config.ts"
import { allowedWorkspace, openAllowedWorkspace, selectProviders } from "./daemon.ts"
import { DeviceId } from "@cohall/protocol"
import { Effect } from "effect"
import { execFile } from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { homedir, platform, tmpdir } from "node:os"
import OperatingSystem from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"
import { parseProviders, parseWorkspaces } from "./config.ts"

const directories: Array<string> = []

const temporary = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-config-"))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  vi.unstubAllEnvs()
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe.skipIf(platform() === "win32" || platform() === "darwin")("XDG storage paths", () => {
  it.each([undefined, "", "relative/config"])(
    "uses the home defaults when XDG directories are %j",
    (value) => {
      vi.stubEnv("COHALL_CONFIG", undefined)
      vi.stubEnv("COHALL_DATA_DIR", undefined)
      vi.stubEnv("XDG_CONFIG_HOME", value)
      vi.stubEnv("XDG_DATA_HOME", value)

      expect(configurationPath()).toBe(join(homedir(), ".config", "cohall", "config.json"))
      expect(relayDataDirectory()).toBe(join(homedir(), ".local", "share", "cohall"))
    },
  )

  it("honors absolute XDG directories and explicit Cohall paths", async () => {
    const directory = await temporary()
    vi.stubEnv("COHALL_CONFIG", undefined)
    vi.stubEnv("COHALL_DATA_DIR", undefined)
    vi.stubEnv("XDG_CONFIG_HOME", join(directory, "config"))
    vi.stubEnv("XDG_DATA_HOME", join(directory, "data"))

    expect(configurationPath()).toBe(join(directory, "config", "cohall", "config.json"))
    expect(relayDataDirectory()).toBe(join(directory, "data", "cohall"))

    vi.stubEnv("COHALL_CONFIG", join(directory, "chosen.json"))
    vi.stubEnv("COHALL_DATA_DIR", join(directory, "chosen-data"))
    expect(configurationPath()).toBe(join(directory, "chosen.json"))
    expect(relayDataDirectory()).toBe(join(directory, "chosen-data"))
  })
})

describe("device workspace configuration", () => {
  it("applies environment credentials and a name override before validating unsaved defaults", async () => {
    const directory = await temporary()
    vi.stubEnv("COHALL_CONFIG", join(directory, "missing.json"))
    vi.stubEnv("COHALL_RELAY_URL", "https://relay.example")
    vi.stubEnv("COHALL_CLIENT_TOKEN", "client-token")
    vi.stubEnv("COHALL_DEVICE_TOKEN", "device-token")
    vi.stubEnv("COHALL_DEVICE_WORKSPACES_JSON", JSON.stringify([directory]))
    vi.stubEnv("COHALL_DEVICE_NAME", "worker")
    vi.spyOn(OperatingSystem, "hostname").mockReturnValue("n".repeat(129))
    syncBuiltinESMExports()

    await expect(Effect.runPromise(loadClientConfiguration)).resolves.toMatchObject({
      token: "client-token",
    })
    await expect(Effect.runPromise(loadDeviceConfiguration)).resolves.toMatchObject({
      name: "worker",
    })
    vi.stubEnv("COHALL_DEVICE_NAME", undefined)
    await expect(Effect.runPromise(loadDeviceConfiguration)).rejects.toThrow("128")
  })

  it("keeps older device names readable for client access and name repair", async () => {
    const directory = await temporary()
    const path = join(directory, "config.json")
    vi.stubEnv("COHALL_CONFIG", path)
    vi.stubEnv("COHALL_RELAY_URL", undefined)
    vi.stubEnv("COHALL_CLIENT_TOKEN", undefined)
    vi.stubEnv("COHALL_DEVICE_TOKEN", undefined)
    vi.stubEnv("COHALL_DEVICE_NAME", undefined)
    const legacy = {
      version: 1,
      relayUrl: "https://relay.example",
      deviceId: "11111111-1111-4111-8111-111111111111",
      deviceName: "n".repeat(129),
      workspaces: [directory],
      clientToken: "client-token",
      deviceToken: "device-token",
    }
    await writeFile(path, JSON.stringify(legacy))

    await expect(Effect.runPromise(loadClientConfiguration)).resolves.toMatchObject({
      token: legacy.clientToken,
    })
    await expect(Effect.runPromise(loadDeviceConfiguration)).rejects.toThrow("128")
    vi.stubEnv("COHALL_DEVICE_NAME", "worker")
    await expect(Effect.runPromise(loadDeviceConfiguration)).resolves.toMatchObject({
      name: "worker",
    })
    const repaired = await makeStoredConfiguration({
      relayUrl: legacy.relayUrl,
      deviceName: "worker",
    })
    await writeStoredConfiguration(repaired)
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      ...legacy,
      deviceName: "worker",
    })
  })

  it.each([128, 129])(
    "validates %i-character stored and environment device names",
    async (length) => {
      const directory = await temporary()
      const path = join(directory, "config.json")
      vi.stubEnv("COHALL_CONFIG", path)
      vi.stubEnv("COHALL_RELAY_URL", undefined)
      const configuration = StoredConfiguration.make({
        version: 1,
        relayUrl: "https://relay.example",
        deviceId: DeviceId.make("11111111-1111-4111-8111-111111111111"),
        deviceName: "workstation",
        workspaces: [directory],
        deviceToken: "device-token",
      })
      await writeStoredConfiguration(configuration)
      const saved = await readFile(path, "utf8")
      const name = "n".repeat(length)
      vi.stubEnv("COHALL_DEVICE_NAME", name)
      const draft = makeStoredConfiguration({ relayUrl: configuration.relayUrl, deviceName: name })
      if (length === 128) {
        await expect(draft).resolves.toMatchObject({ deviceName: name })
        await expect(Effect.runPromise(loadDeviceConfiguration)).resolves.toMatchObject({ name })
      } else {
        await expect(draft).rejects.toThrow("128")
        await expect(Effect.runPromise(loadDeviceConfiguration)).rejects.toThrow("128")
      }
      expect(await readFile(path, "utf8")).toBe(saved)
    },
  )

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

  it("rejects a regular file as a workspace root before saving configuration", async () => {
    const directory = await temporary()
    const file = join(directory, "project.txt")
    await writeFile(file, "a file cannot be a provider working directory")

    await expect(Effect.runPromise(parseWorkspaces(file))).rejects.toThrow(
      "Workspace roots must be existing directories",
    )
    await expect(Effect.runPromise(parseWorkspaces("", JSON.stringify([file])))).rejects.toThrow(
      "Workspace roots must be existing directories",
    )
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

  it("protects provider startup from an authorized workspace replacement", async () => {
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
      if (platform() !== "linux") {
        await expect(authorized.validate()).rejects.toThrow("changed before provider startup")
        return
      }
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
