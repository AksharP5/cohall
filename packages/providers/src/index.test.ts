import { Effect } from "effect"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { run } from "./index.ts"

const directories: Array<string> = []
const originalPath = process.env.PATH

afterEach(async () => {
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
