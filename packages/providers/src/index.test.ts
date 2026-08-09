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
  "cancellation terminates the provider process tree",
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
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
writeFileSync(process.env.PROVIDER_CHILD_PID, String(child.pid))
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
    const childPid = await waitFor(() =>
      readFile(childPidPath, "utf8")
        .then((value) => Number(value))
        .catch(() => undefined),
    )
    expect(isRunning(childPid)).toBe(true)
    controller.abort()
    await running
    await waitFor(() => Promise.resolve(isRunning(childPid) ? undefined : true))
    expect(isRunning(childPid)).toBe(false)
  },
  10_000,
)
