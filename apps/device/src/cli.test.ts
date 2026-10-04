import Filesystem, { mkdtemp, open, rm, writeFile, type FileHandle } from "node:fs/promises"
import { execFile } from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, expect, it, vi } from "vitest"
import * as BotReplies from "./bot-replies.ts"
import { runCli } from "./cli.ts"

vi.mock("../../../skills/cohall/SKILL.md", () => ({ default: "test skill" }))

const directories: Array<string> = []
const taskId = "11111111-1111-4111-8111-111111111111"

const temporary = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-cli-input-"))
  directories.push(directory)
  vi.stubEnv("COHALL_CONFIG", join(directory, "config.json"))
  vi.stubEnv("COHALL_RELAY_URL", "http://127.0.0.1:1")
  vi.stubEnv("COHALL_CLIENT_TOKEN", "test-client-token")
  return directory
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

it.each([
  {
    command: "join",
    arguments: ["--client-only", "--token-file"],
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
  const input = runCli("join", ["--client-only", "--token-file", path])
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
