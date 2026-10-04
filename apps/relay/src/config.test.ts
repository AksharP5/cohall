import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { homedir, platform, tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defaultDataDirectory, loadEnvironmentConfiguration } from "./config.ts"

const directories: Array<string> = []
const previous = {
  token: process.env.COHALL_TOKEN,
  dataDirectory: process.env.COHALL_DATA_DIR,
  historyTaskLimit: process.env.COHALL_HISTORY_TASK_LIMIT,
  host: process.env.COHALL_RELAY_HOST,
  port: process.env.COHALL_RELAY_PORT,
  allowRemote: process.env.COHALL_RELAY_ALLOW_REMOTE,
}

const restore = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = value
}

afterEach(async () => {
  vi.unstubAllEnvs()
  restore("COHALL_TOKEN", previous.token)
  restore("COHALL_DATA_DIR", previous.dataDirectory)
  restore("COHALL_HISTORY_TASK_LIMIT", previous.historyTaskLimit)
  restore("COHALL_RELAY_HOST", previous.host)
  restore("COHALL_RELAY_PORT", previous.port)
  restore("COHALL_RELAY_ALLOW_REMOTE", previous.allowRemote)
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe.skipIf(platform() === "win32" || platform() === "darwin")("XDG relay data path", () => {
  it.each([undefined, "", "relative/data"])(
    "uses the home default when XDG_DATA_HOME is %j",
    (value) => {
      vi.stubEnv("XDG_DATA_HOME", value)
      expect(defaultDataDirectory()).toBe(join(homedir(), ".local", "share", "cohall"))
    },
  )

  it("honors an absolute XDG_DATA_HOME", () => {
    const directory = join(tmpdir(), "cohall-xdg-data")
    vi.stubEnv("XDG_DATA_HOME", directory)
    expect(defaultDataDirectory()).toBe(join(directory, "cohall"))
  })
})

const configure = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-relay-config-"))
  directories.push(directory)
  process.env.COHALL_DATA_DIR = directory
  process.env.COHALL_RELAY_HOST = "127.0.0.1"
  process.env.COHALL_RELAY_PORT = "8787"
  delete process.env.COHALL_RELAY_ALLOW_REMOTE
}

it("rejects weak configured owner credentials", async () => {
  await configure()
  process.env.COHALL_TOKEN = "short"
  await expect(Effect.runPromise(loadEnvironmentConfiguration)).rejects.toThrow(
    "must be at least 32 characters",
  )
})

it("validates the retained terminal task limit", async () => {
  await configure()
  process.env.COHALL_TOKEN = "a".repeat(64)
  process.env.COHALL_HISTORY_TASK_LIMIT = "99"
  await expect(Effect.runPromise(loadEnvironmentConfiguration)).rejects.toThrow()
})
