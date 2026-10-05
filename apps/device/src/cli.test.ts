import Filesystem, { mkdtemp, open, rm, writeFile, type FileHandle } from "node:fs/promises"
import { execFile } from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import OperatingSystem from "node:os"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, expect, it, vi } from "vitest"
import * as z from "zod/v4"
import { DeviceId } from "@cohall/protocol"
import * as BotReplies from "./bot-replies.ts"
import { runCli } from "./cli.ts"
import { StoredConfiguration, readStoredConfiguration, writeStoredConfiguration } from "./config.ts"

vi.mock("../../../skills/cohall/SKILL.md", () => ({ default: "test skill" }))
vi.mock("../../../docs/onboarding.md", () => ({ default: "test onboarding guide" }))

const directories: Array<string> = []
const taskId = "11111111-1111-4111-8111-111111111111"

const temporary = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-cli-input-"))
  directories.push(directory)
  vi.stubEnv("HOME", directory)
  vi.stubEnv("USERPROFILE", directory)
  vi.stubEnv("XDG_CONFIG_HOME", join(directory, ".config"))
  vi.spyOn(OperatingSystem, "homedir").mockReturnValue(directory)
  syncBuiltinESMExports()
  vi.stubEnv("COHALL_CONFIG", join(directory, "config.json"))
  vi.stubEnv("COHALL_RELAY_URL", "http://127.0.0.1:1")
  vi.stubEnv("COHALL_CLIENT_TOKEN", "test-client-token")
  return directory
}

const storeWorkerConfiguration = async (directory: string): Promise<StoredConfiguration> => {
  const configuration = StoredConfiguration.make({
    version: 1,
    relayUrl: "https://relay.example",
    deviceId: DeviceId.make(taskId),
    deviceName: "workstation",
    workspaces: [join(directory, "removed-workspace")],
    clientToken: "client-secret",
    deviceToken: "device-secret",
    providers: ["claude-code"],
    model: "saved-model",
    sandbox: "read-only",
    grokGateway: join(directory, "gateway.json"),
  })
  await writeStoredConfiguration(configuration)
  return configuration
}

const trackInputHandles = (path: string): Array<FileHandle> => {
  const handles: Array<FileHandle> = []
  const originalOpen = Filesystem.open
  vi.spyOn(Filesystem, "open").mockImplementation(async (file, flags, mode) => {
    const handle = await originalOpen(file, flags, mode)
    if (file === path && flags === "r") handles.push(handle)
    return handle
  })
  syncBuiltinESMExports()
  return handles
}

afterEach(async () => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

it.each(["init", "join"] as const)(
  "requires a relay for a fresh %s before reading its token",
  async (command) => {
    const directory = await temporary()
    const path = join(directory, "token.txt")
    await writeFile(path, "pairing-secret")
    const open = vi.spyOn(Filesystem, "open")
    syncBuiltinESMExports()
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("Pairing started"))
    vi.stubGlobal("fetch", fetch)
    await expect(runCli(command, ["--client-only", "--token-file", path])).rejects.toThrow(
      "Relay URL is required",
    )
    expect(fetch).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  },
)

it.each([true, false])(
  "repairs missing workspace settings only for client-only=%s",
  async (clientOnly) => {
    const directory = await temporary()
    const configuration = await storeWorkerConfiguration(directory)
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error("Unexpected pairing"))
    vi.stubGlobal("fetch", fetch)
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    if (clientOnly) {
      await runCli("init", ["--client-only"])
      expect(await readStoredConfiguration()).toEqual(configuration)
      expect(
        await Filesystem.readFile(
          join(directory, ".agents", "skills", "cohall", "SKILL.md"),
          "utf8",
        ),
      ).toBe("test skill")
    } else {
      await expect(runCli("init", [])).rejects.toThrow(
        "Workspace roots must be existing directories",
      )
    }
    expect(fetch).not.toHaveBeenCalled()
  },
)

it("exchanges an explicit init token file despite existing client credentials and unused roots", async () => {
  const directory = await temporary()
  const configuration = await storeWorkerConfiguration(directory)
  const path = join(directory, "token.txt")
  await writeFile(path, "new-pairing-token")
  const timestamp = "2026-10-04T12:00:00.000Z"
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        credentials: [
          {
            token: "new-client-secret",
            session: {
              id: taskId,
              label: "New client",
              role: "client",
              createdAt: timestamp,
              expiresAt: timestamp,
              lastSeenAt: timestamp,
            },
          },
        ],
      }),
    ),
  )
  vi.stubGlobal("fetch", fetch)
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  await runCli("init", ["--client-only", "--token-file", path])
  expect(fetch).toHaveBeenCalledOnce()
  expect(fetch).toHaveBeenCalledWith(
    "https://relay.example/api/auth/pair",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ token: "new-pairing-token" }),
    }),
  )
  expect(await readStoredConfiguration()).toMatchObject({
    clientToken: "new-client-secret",
    workspaces: configuration.workspaces,
    providers: configuration.providers,
  })
})

it("rejects a client-only device service before changing configuration", async () => {
  const directory = await temporary()
  const path = join(directory, "token.txt")
  await writeFile(path, "pairing-secret")
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("Pairing started"))
  vi.stubGlobal("fetch", fetch)
  await expect(
    runCli("init", [
      "--relay",
      "https://relay.example",
      "--client-only",
      "--service",
      "--token-file",
      path,
    ]),
  ).rejects.toThrow("A client-only setup cannot install a device service")
  expect(fetch).not.toHaveBeenCalled()
  await expect(Filesystem.access(join(directory, "config.json"))).rejects.toThrow()
})

it.each([false, true])(
  "returns a secret-free pairing brief for client-only=%s",
  async (clientOnly) => {
    await temporary()
    vi.stubEnv("COHALL_TOKEN", "test-owner-token".padEnd(64, "0"))
    const token = "private-one-time-pairing-token"
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ token, expiresAt: "2026-10-04T19:00:00.000Z" }), {
        headers: { "content-type": "application/json" },
      }),
    )
    vi.stubGlobal("fetch", fetch)
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined)
    await runCli("pair", clientOnly ? ["--client-only"] : [])
    const report = z
      .object({
        pairing_token: z.string(),
        roles: z.array(z.enum(["client", "device"])),
        join_instructions: z.string(),
      })
      .parse(JSON.parse(String(output.mock.calls[0]?.[0])))
    expect(report.pairing_token).toBe(token)
    expect(report.roles).toEqual(clientOnly ? ["client"] : ["client", "device"])
    expect(report.join_instructions).toContain("http://127.0.0.1:1")
    expect(report.join_instructions).toContain(
      clientOnly ? "init --client-only" : "a worker and client",
    )
    expect(report.join_instructions).not.toContain(token)
  },
)

it.each([
  {
    command: "join",
    arguments: ["--relay", "https://relay.example", "--client-only", "--token-file"],
    grown: `${" ".repeat(1024)}fake-token`,
    error: "Pairing token file exceeds 512 bytes",
  },
  {
    command: "delegate",
    arguments: ["--prompt-file"],
    grown: "é".repeat(100_000),
    error: "prompt file exceeds 128 KiB",
  },
  {
    command: "delegate",
    arguments: ["A prompt", "--context-file"],
    grown: "é".repeat(100_000),
    error: "context file exceeds 128 KiB",
  },
  {
    command: "reply",
    arguments: [taskId, "--message-file"],
    grown: "x".repeat(524_289),
    error: "message file exceeds 512 KiB",
  },
])("bounds $command input on Windows and Unix when its file grows after stat", async (test) => {
  const directory = await temporary()
  const path = join(directory, "input.txt")
  await writeFile(path, "small")
  const metadata = await Filesystem.stat(path)
  const originalStat = Filesystem.stat
  vi.spyOn(Filesystem, "stat").mockImplementation(async (file) => {
    if (file !== path) return originalStat(file)
    await writeFile(path, test.grown)
    return metadata
  })
  syncBuiltinESMExports()
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("Input reached relay"))
  vi.stubGlobal("fetch", fetch)
  const reply = vi.spyOn(BotReplies, "writeBotReply").mockResolvedValue(undefined)
  const handles = trackInputHandles(path)

  await expect(runCli(test.command, [...test.arguments, path])).rejects.toThrow(test.error)
  expect(fetch).not.toHaveBeenCalled()
  expect(reply).not.toHaveBeenCalled()
  expect(handles).toHaveLength(1)
  expect(handles[0]?.fd).toBe(-1)
})

it("preserves UTF-8 short reads and closes the input file on Windows and Unix", async () => {
  const directory = await temporary()
  const path = join(directory, "message.txt")
  const message = "A reply with é and 日本語"
  await writeFile(path, message)
  const handle = await open(path)
  const prototype = Object.getPrototypeOf(handle) as Pick<FileHandle, "read">
  await handle.close()
  const originalRead = prototype.read
  const read = vi.spyOn(prototype, "read").mockImplementation(function (this: FileHandle, options) {
    return originalRead.call(this, { ...options, length: Math.min(options?.length ?? 2, 2) })
  })
  const reply = vi.spyOn(BotReplies, "writeBotReply").mockResolvedValue(undefined)
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  const handles = trackInputHandles(path)

  await runCli("reply", [taskId, "--message-file", path])
  expect(reply).toHaveBeenCalledWith(taskId, { result: message }, undefined)
  expect(read.mock.calls.length).toBeGreaterThan(1)
  expect(handles).toHaveLength(1)
  expect(handles[0]?.fd).toBe(-1)
})

it.skipIf(process.platform === "win32")("bounds a finite token stream to 513 bytes", async () => {
  const directory = await temporary()
  const path = join(directory, "token-pipe")
  const probe = join(directory, "probe.txt")
  await writeFile(probe, "probe")
  const handle = await open(probe)
  const prototype = Object.getPrototypeOf(handle) as Pick<FileHandle, "read">
  await handle.close()
  const originalRead = prototype.read
  let bytes = 0
  vi.spyOn(prototype, "read").mockImplementation(async function (this: FileHandle, options) {
    const result = await originalRead.call(this, options)
    bytes += result.bytesRead
    return result
  })
  const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("Input reached relay"))
  vi.stubGlobal("fetch", fetch)
  await promisify(execFile)("mkfifo", [path])
  const handles = trackInputHandles(path)
  const input = runCli("join", [
    "--relay",
    "https://relay.example",
    "--client-only",
    "--token-file",
    path,
  ])
  const producer = open(path, "w").then(async (writer) => {
    try {
      await writer.writeFile(`${" ".repeat(1024)}fake-token`)
    } finally {
      await writer.close()
    }
  })
  const [submission, written] = await Promise.allSettled([input, producer])

  expect(submission).toMatchObject({
    status: "rejected",
    reason: new Error("Pairing token file exceeds 512 bytes"),
  })
  expect(written.status).toBe("fulfilled")
  expect(bytes).toBe(513)
  expect(fetch).not.toHaveBeenCalled()
  expect(handles).toHaveLength(1)
  expect(handles[0]?.fd).toBe(-1)
})
