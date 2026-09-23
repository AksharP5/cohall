import { BotId, DeviceId, Task, TaskId, ThreadId, Timestamp } from "@cohall/protocol"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  claimBotDispatch,
  cleanupBotReply,
  prepareBotReply,
  readBotReply,
  writeBotReply,
} from "./bot-replies.ts"

const timestamp = Timestamp.make("2026-08-09T12:00:00.000Z")
const task = Task.make({
  id: TaskId.make("11111111-1111-4111-8111-111111111111"),
  threadId: ThreadId.make("22222222-2222-4222-8222-222222222222"),
  targetDeviceId: DeviceId.make("33333333-3333-4333-8333-333333333333"),
  provider: "grok-bot",
  botId: BotId.make("research-bot"),
  status: "running",
  prompt: "Research a project",
  createdAt: timestamp,
  updatedAt: timestamp,
})
const executeFile = promisify(execFile)
let directory: string
let records: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cohall-bot-replies-"))
  records = join(directory, "bot-replies")
  vi.stubEnv("COHALL_CONFIG", join(directory, "config.json"))
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

describe("local bot replies", () => {
  it("persists the original deadline and dispatch intent across resumed tasks", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000)
    const prepared = await prepareBotReply(task)
    expect(prepared.deadline).toBe(1_000 + 6 * 60 * 60 * 1_000)
    expect(prepared.dispatched).toBe(false)
    expect((await stat(records)).mode & 0o777).toBe(0o700)
    expect((await stat(join(records, `${task.id}.pending.json`))).mode & 0o777).toBe(0o600)
    expect(await claimBotDispatch(task.id)).toBe(true)
    clock.mockReturnValue(prepared.deadline + 1)
    expect(await prepareBotReply(task)).toEqual({ ...prepared, dispatched: true })
    await expect(writeBotReply(task.id, { result: "late" })).rejects.toThrow("deadline")
    clock.mockReturnValue(2_000)
    expect(await claimBotDispatch(task.id)).toBe(false)
    await expect(
      prepareBotReply(Task.make({ ...task, botId: BotId.make("different-bot") })),
    ).rejects.toThrow("does not match")
    await writeFile(
      join(records, `${task.id}.dispatch.json`),
      JSON.stringify({
        taskId: "44444444-4444-4444-8444-444444444444",
      }),
    )
    await expect(prepareBotReply(task)).rejects.toThrow("Invalid local bot dispatch record")
  })

  it("returns timely results after the deadline and accepts identical retries", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000)
    const prepared = await prepareBotReply(task)
    await writeBotReply(task.id, { result: "Complete result" })
    clock.mockReturnValue(prepared.deadline + 1)
    expect(await readBotReply(task.id)).toEqual({ result: "Complete result" })
    await expect(writeBotReply(task.id, { result: "Complete result" })).resolves.toBeUndefined()
    await expect(writeBotReply(task.id, { error: "changed" })).rejects.toThrow("different reply")
    expect((await stat(join(records, `${task.id}.reply.json`))).mode & 0o777).toBe(0o600)
  })

  it("publishes one complete reply atomically when submissions race", async () => {
    await prepareBotReply(task)
    await writeFile(join(records, `${task.id}.reply.json.partial.tmp`), '{"reply":')
    expect(await readBotReply(task.id)).toBeUndefined()
    const replies = await Promise.allSettled([
      writeBotReply(task.id, { result: "x".repeat(131_072) }),
      writeBotReply(task.id, { error: "Could not finish" }),
    ])
    expect(replies.filter((reply) => reply.status === "fulfilled")).toHaveLength(1)
    const reply = await readBotReply(task.id)
    expect(reply).toBeDefined()
    expect(reply).toEqual(
      replies[0]?.status === "fulfilled"
        ? { result: "x".repeat(131_072) }
        : { error: "Could not finish" },
    )
    expect((await readdir(records)).filter((name) => name.endsWith(".tmp"))).toEqual([
      `${task.id}.reply.json.partial.tmp`,
    ])
    expect(
      (await Promise.all([claimBotDispatch(task.id), claimBotDispatch(task.id)])).sort(),
    ).toEqual([false, true])
  })

  it("rejects unregistered tasks, oversized replies, and invalid persisted records", async () => {
    expect(await readBotReply(task.id)).toBeUndefined()
    await expect(writeBotReply(task.id, { result: "No manifest" })).rejects.toThrow("No pending")
    await expect(Reflect.apply(readBotReply, undefined, ["../../outside"])).rejects.toThrow()
    await prepareBotReply(task)
    await expect(writeBotReply(task.id, { result: "x".repeat(131_073) })).rejects.toThrow("131072")
    await expect(writeBotReply(task.id, { error: "x".repeat(16_385) })).rejects.toThrow("16384")
    await expect(
      Reflect.apply(writeBotReply, undefined, [task.id, { result: "result", error: "error" }]),
    ).rejects.toThrow("Provide a result")
    const path = join(records, `${task.id}.pending.json`)
    const pending = JSON.parse(await readFile(path, "utf8"))
    await writeFile(
      path,
      JSON.stringify({ ...pending, taskId: "44444444-4444-4444-8444-444444444444" }),
    )
    await expect(readBotReply(task.id)).rejects.toThrow("Invalid local bot reply manifest")
  })

  it("isolates configuration directories and removes only the exact task records", async () => {
    await prepareBotReply(task)
    await claimBotDispatch(task.id)
    await writeBotReply(task.id, { error: "Needs input" })
    vi.stubEnv("COHALL_CONFIG", join(directory, "other", "config.json"))
    expect(await readBotReply(task.id)).toBeUndefined()
    await expect(writeBotReply(task.id, { result: "wrong namespace" })).rejects.toThrow(
      "No pending",
    )
    vi.stubEnv("COHALL_CONFIG", join(directory, "config.json"))
    await writeFile(join(records, "keep.txt"), "unrelated")
    await cleanupBotReply(task.id)
    await cleanupBotReply(task.id)
    expect(await readdir(records)).toEqual(["keep.txt"])
  })

  it("quotes callback commands and lets the CLI reply without relay credentials", async () => {
    const configPath = join(directory, "space ' $(touch should-not-exist)", "config.json")
    vi.stubEnv("COHALL_CONFIG", configPath)
    const prepared = await prepareBotReply(task)
    const bin = join(directory, "bin")
    await mkdir(bin)
    await writeFile(join(bin, "cohall"), '#!/bin/sh\nprintf "%s\\n" "$COHALL_CONFIG" "$@"\n', {
      mode: 0o755,
    })
    const quoted = await executeFile("/bin/sh", ["-c", `${prepared.command} reply ${task.id}`], {
      cwd: directory,
      env: { ...process.env, PATH: bin },
    })
    expect(quoted.stdout.trimEnd().split("\n")).toEqual([configPath, "reply", task.id])
    const replyPath = join(directory, "message.txt")
    const message = `A private completed result ${"é".repeat(70_000)}`
    await writeFile(replyPath, message)
    const response = await executeFile(
      "node",
      ["bin/cohall.js", "reply", task.id, "--message-file", replyPath],
      {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH, COHALL_CONFIG: configPath },
      },
    )
    expect(JSON.parse(response.stdout)).toEqual({ submitted: true, task_id: task.id })
    expect(response.stdout).not.toContain("private completed result")
    expect(await readBotReply(task.id)).toEqual({ result: message })
    await cleanupBotReply(task.id)
    await prepareBotReply(task)
    const stdinOutput = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        "node",
        ["bin/cohall.js", "reply", task.id, "--message", "-"],
        {
          cwd: process.cwd(),
          env: { PATH: process.env.PATH, COHALL_CONFIG: configPath },
        },
        (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
      )
      child.stdin?.end("Result from stdin")
    })
    expect(JSON.parse(stdinOutput)).toMatchObject({ submitted: true })
    expect(await readBotReply(task.id)).toEqual({ result: "Result from stdin" })
    await cleanupBotReply(task.id)
    await prepareBotReply(task)
    await executeFile(
      "node",
      ["bin/cohall.js", "reply", task.id, "--error", "Needs clarification"],
      {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH, COHALL_CONFIG: configPath },
      },
    )
    expect(await readBotReply(task.id)).toEqual({ error: "Needs clarification" })
  })
})
