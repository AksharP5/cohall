import { Effect } from "effect"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, relative } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { findExecutable, run, type CliProvider } from "./index.ts"

const directories: Array<string> = []
const originalPath = process.env.PATH

afterEach(async () => {
  vi.unstubAllEnvs()
  process.env.PATH = originalPath
  delete process.env.PROVIDER_CHILD_PID
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const waitFor = async <A>(read: () => Promise<A | undefined>): Promise<A> => {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) {
      return value
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("Timed out waiting for provider fixture")
}

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const runWithEvents = async (provider: CliProvider, events: ReadonlyArray<unknown>) => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-provider-events-"))
  directories.push(directory)
  const program = `require("node:fs").createReadStream(require("node:path").join(__dirname, "events.ndjson")).pipe(process.stdout)`
  if (process.platform === "win32") {
    await writeFile(join(directory, "provider.cjs"), program)
    await writeFile(
      join(directory, `${provider}.cmd`),
      `@ECHO off\r\n"${process.execPath}" "%~dp0provider.cjs"\r\n`,
    )
  } else {
    await writeFile(join(directory, provider), `#!${process.execPath}\n${program}\n`, {
      mode: 0o755,
    })
  }
  await writeFile(
    join(directory, "events.ndjson"),
    events.map((event) => JSON.stringify(event)).join("\n"),
  )
  process.env.PATH = directory
  return Effect.runPromise(run({ provider, threadId: "test", prompt: "test", cwd: directory }))
}

it("skips directories shadowing executable files, including Windows shims", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-provider-discovery-"))
  directories.push(directory)
  const shadow = join(directory, "shadow")
  const bin = join(directory, "bin")
  const name = process.platform === "win32" ? "codex.cmd" : "codex"
  await mkdir(join(shadow, name), { recursive: true })
  await mkdir(bin)
  const executable = join(bin, name)
  await writeFile(executable, "", { mode: 0o755 })
  process.env.PATH = `${shadow}${delimiter}${bin}`
  if (process.platform === "win32") vi.stubEnv("PATHEXT", ".CMD")

  expect(findExecutable(join(shadow, name))).toBeUndefined()
  expect(findExecutable("codex")).toBe(executable)
})

it("runs providers from relative PATH entries in another workspace, including Windows shims", async () => {
  const directory = await mkdtemp(join(dirname(process.cwd()), ".cohall-provider-relative-"))
  directories.push(directory)
  const bin = join(directory, "bin")
  const workspace = join(directory, "workspace")
  await mkdir(bin)
  await mkdir(workspace)
  const helper = `process.stdout.write("helper-ok")`
  const program = `process.stdin.resume()
process.stdin.on("end", () => {
  const result = require("node:child_process").spawnSync("cohall-provider-helper", [], {
    encoding: "utf8",
    shell: process.platform === "win32"
  })
  if (result.error || result.status !== 0) {
    console.error(result.error?.message || result.stderr)
    process.exit(1)
  }
  console.log(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: JSON.stringify({ cwd: process.cwd(), helper: result.stdout }) }
  }))
})`
  if (process.platform === "win32") {
    vi.stubEnv("PATHEXT", ".CMD")
    await writeFile(join(bin, "provider.cjs"), program)
    await writeFile(
      join(bin, "codex.cmd"),
      `@ECHO off\r\n"${process.execPath}" "%~dp0provider.cjs"\r\n`,
    )
    await writeFile(join(bin, "helper.cjs"), helper)
    await writeFile(
      join(bin, "cohall-provider-helper.cmd"),
      `@ECHO off\r\n"${process.execPath}" "%~dp0helper.cjs"\r\n`,
    )
  } else {
    await writeFile(join(bin, "codex"), `#!${process.execPath}\n${program}\n`, { mode: 0o755 })
    await writeFile(join(bin, "cohall-provider-helper"), `#!${process.execPath}\n${helper}\n`, {
      mode: 0o755,
    })
  }
  process.env.PATH = relative(process.cwd(), bin)

  await expect(
    Effect.runPromise(run({ provider: "codex", threadId: "test", prompt: "test", cwd: workspace })),
  ).resolves.toEqual({ result: JSON.stringify({ cwd: workspace, helper: "helper-ok" }) })
})

const openCodeText = (messageId: string, partId: string, content: string) => ({
  type: "text",
  timestamp: 1,
  sessionID: "ses_fixture",
  part: {
    id: partId,
    messageID: messageId,
    sessionID: "ses_fixture",
    type: "text",
    text: content,
    time: { start: 1, end: 2 },
  },
})

it("keeps distinct OpenCode answer parts from the final message and replaces repeated updates", async () => {
  await expect(
    runWithEvents("opencode", [
      openCodeText("msg_commentary", "prt_commentary", "Checking the request."),
      openCodeText("msg_final", "prt_first", "The request failed."),
      openCodeText("msg_final", "prt_removed", "Outdated diagnosis."),
      openCodeText("msg_final", "prt_second", "Add accountId before retrying."),
      openCodeText("msg_final", "prt_first", "The request is missing its account ID."),
      openCodeText("msg_final", "prt_removed", ""),
      { type: "step_finish", sessionID: "ses_fixture", part: { reason: "stop" } },
    ]),
  ).resolves.toEqual({
    result: "The request is missing its account ID.\nAdd accountId before retrying.",
    sessionId: "ses_fixture",
  })
})

it("keeps the last OpenCode response when legacy text events omit part identities", async () => {
  await expect(
    runWithEvents("opencode", [
      { type: "text", sessionID: "ses_legacy", part: { text: "Checking the request." } },
      { type: "text", part: { text: "The final answer." } },
    ]),
  ).resolves.toEqual({ result: "The final answer.", sessionId: "ses_legacy" })
})

it.each([
  { limit: "result", partCharacters: 32_768, laterMessage: false },
  { limit: "result", partCharacters: 32_768, laterMessage: true },
  { limit: "buffer", partCharacters: 262_144, laterMessage: false },
  { limit: "buffer", partCharacters: 262_144, laterMessage: true },
])(
  "bounds combined OpenCode $limit bytes, later final message=$laterMessage",
  async ({ limit, partCharacters, laterMessage }) => {
    const result = runWithEvents("opencode", [
      openCodeText("msg_large", "prt_first", "é".repeat(partCharacters)),
      openCodeText("msg_large", "prt_second", "é".repeat(partCharacters + 1)),
      ...(laterMessage ? [openCodeText("msg_final", "prt_final", "The final answer.")] : []),
    ])
    if (laterMessage) {
      await expect(result).resolves.toEqual({
        result: "The final answer.",
        sessionId: "ses_fixture",
      })
      return
    }
    await expect(result).rejects.toMatchObject({
      _tag: "CohallProvider.RunError",
      message:
        limit === "buffer" ? "OpenCode message exceeded 1 MiB" : "Provider result exceeded 128 KiB",
    })
  },
)

it("replaces an OpenCode part that brings the final message back within its byte budget", async () => {
  const first = "é".repeat(32_768)
  const second = `${"é".repeat(32_767)}x`
  await expect(
    runWithEvents("opencode", [
      openCodeText("msg_final", "prt_first", first),
      openCodeText("msg_final", "prt_second", `${second}x`),
      openCodeText("msg_final", "prt_second", second),
    ]),
  ).resolves.toEqual({ result: `${first}\n${second}`, sessionId: "ses_fixture" })
})

it("bounds retained OpenCode part identities after their text is replaced with empty content", async () => {
  const first = "a".repeat(524_288)
  const second = "b".repeat(524_288)
  await expect(
    runWithEvents("opencode", [
      openCodeText("msg_final", first, "Obsolete text."),
      openCodeText("msg_final", first, ""),
      openCodeText("msg_final", second, "The answer."),
    ]),
  ).rejects.toMatchObject({
    _tag: "CohallProvider.RunError",
    message: "OpenCode message exceeded 1 MiB",
  })
})

it("rejects a partial identified OpenCode answer after a discarded event in its message", async () => {
  await expect(
    runWithEvents("opencode", [
      {
        type: "step_start",
        sessionID: "ses_fixture",
        part: { id: "prt_step", messageID: "msg_final", type: "step-start" },
      },
      openCodeText("msg_final", "prt_first", "The request failed."),
      openCodeText("msg_final", "prt_large", "x".repeat(1_126_400)),
      openCodeText("msg_final", "prt_last", "Retry it."),
    ]),
  ).rejects.toMatchObject({
    _tag: "CohallProvider.RunError",
    message: "Provider JSON event exceeded 1 MiB without a later text response",
  })
})

it("recovers an identified OpenCode answer when a new message starts after a discarded event", async () => {
  await expect(
    runWithEvents("opencode", [
      openCodeText("msg_commentary", "prt_commentary", "Checking the request."),
      { type: "tool_use", part: { output: "x".repeat(1_126_400) } },
      {
        type: "step_start",
        sessionID: "ses_fixture",
        part: { id: "prt_step", messageID: "msg_final", type: "step-start" },
      },
      openCodeText("msg_final", "prt_first", "The request failed."),
      openCodeText("msg_final", "prt_second", "Add accountId before retrying."),
    ]),
  ).resolves.toEqual({
    result: "The request failed.\nAdd accountId before retrying.",
    sessionId: "ses_fixture",
  })
})

for (const provider of ["codex", "opencode"] as const) {
  const response = (text: string) =>
    provider === "codex"
      ? { type: "item.completed", item: { type: "agent_message", text } }
      : { type: "text", part: { text } }

  it.each([undefined, "earlier answer"])(
    `${provider} rejects a discarded final answer after %s`,
    async (earlier) => {
      await expect(
        runWithEvents(provider, [
          ...(earlier === undefined ? [] : [response(earlier)]),
          response("x".repeat(1_126_400)),
        ]),
      ).rejects.toMatchObject({
        _tag: "CohallProvider.RunError",
        message: "Provider JSON event exceeded 1 MiB without a later text response",
      })
    },
  )

  it(`${provider} accepts a later answer after an oversized tool event`, async () => {
    await expect(
      runWithEvents(provider, [
        response("earlier answer"),
        { type: "tool_result", content: "x".repeat(1_126_400) },
        response("final answer"),
      ]),
    ).resolves.toMatchObject({ result: "final answer" })
  })

  it(`${provider} rejects a discarded answer followed only by tool output`, async () => {
    await expect(
      runWithEvents(provider, [
        response("x".repeat(1_126_400)),
        { type: "tool_result", content: "tool output" },
      ]),
    ).rejects.toMatchObject({
      _tag: "CohallProvider.RunError",
      message: "Provider JSON event exceeded 1 MiB without a later text response",
    })
  })
}

it.skipIf(process.platform === "win32")(
  "cancellation waits for the provider process tree to terminate",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cohall-provider-tree-"))
    directories.push(directory)
    const childPidPath = join(directory, "child.pid")
    const executable = join(directory, "codex")
    await writeFile(
      executable,
      `#!${process.execPath}
const { spawn } = require("node:child_process")
const { writeFileSync } = require("node:fs")
process.on("SIGTERM", () => setTimeout(() => process.exit(0), 100))
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
writeFileSync(process.env.PROVIDER_CHILD_PID, JSON.stringify({ parent: process.pid, child: child.pid }))
setInterval(() => {}, 1000)
`,
    )
    await chmod(executable, 0o755)
    process.env.PATH = directory
    process.env.PROVIDER_CHILD_PID = childPidPath

    const controller = new AbortController()
    const running = Effect.runPromise(
      run({ provider: "codex", threadId: "test", prompt: "test", cwd: directory }),
      { signal: controller.signal },
    ).catch(() => undefined)
    const pids = await waitFor(() =>
      readFile(childPidPath, "utf8")
        .then((value) => JSON.parse(value) as { parent: number; child: number })
        .catch(() => undefined),
    )
    expect(isRunning(pids.child)).toBe(true)
    controller.abort()
    await running
    expect(isRunning(pids.parent)).toBe(false)
    expect(isRunning(pids.child)).toBe(false)
  },
  10_000,
)

it.skipIf(process.platform === "win32")(
  "reports a failed prompt write without crashing the worker",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cohall-provider-input-"))
    directories.push(directory)
    const executable = join(directory, "codex")
    await writeFile(
      executable,
      `#!${process.execPath}
require("node:fs").closeSync(0)
setInterval(() => {}, 1000)
`,
      { mode: 0o755 },
    )
    process.env.PATH = directory

    await expect(
      Effect.runPromise(
        run({ provider: "codex", threadId: "test", prompt: "x".repeat(262_144), cwd: directory }),
      ),
    ).rejects.toMatchObject({
      _tag: "CohallProvider.RunError",
      message: expect.stringMatching(/EPIPE|ECONNRESET/),
    })
  },
)

it.skipIf(process.platform === "win32")(
  "waits for pending preparation before finishing cancellation",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cohall-provider-preparation-"))
    directories.push(directory)
    await writeFile(join(directory, "codex"), `#!${process.execPath}\nprocess.exit(0)\n`, {
      mode: 0o755,
    })
    process.env.PATH = directory
    const ready = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const controller = new AbortController()
    let settled = false
    const running = Effect.runPromise(
      run({
        provider: "codex",
        threadId: "test",
        prompt: "test",
        cwd: directory,
        beforeSpawn: () => {
          ready.resolve()
          return release.promise
        },
      }),
      { signal: controller.signal },
    )
      .catch(() => undefined)
      .finally(() => {
        settled = true
      })
    await ready.promise
    controller.abort()
    await new Promise<void>((resolve) => setImmediate(resolve))
    const settledBeforeRelease = settled
    release.resolve()
    await running
    expect(settledBeforeRelease).toBe(false)
  },
)

it.skipIf(process.platform !== "win32")(
  "runs Windows provider shims with literal arguments and prompts on stdin",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cohall provider & args-"))
    directories.push(directory)
    await writeFile(
      join(directory, "codex.cmd"),
      `@ECHO off\r\n"${process.execPath}" "%~dp0provider.cjs" %*\r\n`,
    )
    await writeFile(
      join(directory, "provider.cjs"),
      `let input = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => input += chunk)
process.stdin.on("end", () => console.log(JSON.stringify({
  type: "item.completed",
  item: {type: "agent_message", text: JSON.stringify({input, args: process.argv.slice(2), hasToken: process.env.COHALL_TOKEN !== undefined})}
})))
`,
    )
    process.env.PATH = directory
    vi.stubEnv("cohall_token", "fixture token")
    expect(Object.keys(process.env)).toContain("cohall_token")
    expect(process.env.COHALL_TOKEN).toBe("fixture token")
    const model = 'model with spaces & echo injected > injected.txt | ^% ! "quoted"'
    const prompt = "Review this literally:\n& echo not-a-command > untouched.txt\nUnicode: café"
    const response = await Effect.runPromise(
      run({ provider: "codex", threadId: "test", prompt, cwd: directory, model }),
    )
    expect(JSON.parse(response.result)).toEqual({
      input: prompt,
      hasToken: false,
      args: [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "-c",
        'approval_policy="never"',
        "--model",
        model,
        "-",
      ],
    })
  },
)
