import {
  SocketEvent,
  Task,
  makeDeviceId,
  makeTaskId,
  makeThreadId,
  now,
} from "../packages/protocol/src/index.ts"
import { Schema } from "effect"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { expect, it, vi } from "vitest"
import { WebSocketServer } from "ws"

const killProviderGroup = (pid: number): void => {
  try {
    process.kill(-pid, "SIGKILL")
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause
  }
}

it.skipIf(process.platform === "win32").each(["SIGTERM", "SIGINT"] as const)(
  "stops the provider before the standalone worker exits on %s",
  async (signal) => {
    const directory = await mkdtemp(join(tmpdir(), "cohall-worker-stop-"))
    const pidPath = join(directory, "provider.pid")
    const cleanedPath = join(directory, "cleaned")
    await writeFile(
      join(directory, "codex"),
      `#!${process.execPath}
const { writeFileSync } = require("node:fs")
writeFileSync(process.env.AUDIT_PID_FILE, String(process.pid))
console.log(JSON.stringify({ type: "thread.started", thread_id: "shutdown-test" }))
process.on("SIGTERM", () => setTimeout(() => {
  writeFileSync(process.env.AUDIT_CLEANED_FILE, "done")
  process.exit(0)
}, 150))
setInterval(() => {}, 1000)
`,
      { mode: 0o755 },
    )
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
    await once(server, "listening")
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("Missing worker test port")
    const deviceId = makeDeviceId()
    const task = Task.make({
      id: makeTaskId(),
      threadId: makeThreadId(),
      targetDeviceId: deviceId,
      prompt: "Wait for shutdown",
      provider: "codex",
      status: "assigned",
      createdAt: now(),
      updatedAt: now(),
    })
    server.once("connection", (socket) => {
      socket.once("message", () =>
        socket.send(
          JSON.stringify({ _tag: "Connected", serverVersion: "test", connectedAt: now() }),
        ),
      )
      socket.on("message", (message) => {
        const event = Schema.decodeUnknownSync(SocketEvent)(JSON.parse(message.toString()))
        if (event._tag === "DeviceHello")
          socket.send(JSON.stringify({ _tag: "TaskAssigned", task }))
      })
    })
    const worker = spawn(process.execPath, ["bin/cohall.js", "device"], {
      cwd: process.cwd(),
      stdio: "ignore",
      env: {
        ...process.env,
        PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
        COHALL_CONFIG: join(directory, "config.json"),
        COHALL_RELAY_URL: `http://127.0.0.1:${address.port}`,
        COHALL_DEVICE_TOKEN: "shutdown-test-token",
        COHALL_DEVICE_ID: deviceId,
        COHALL_DEVICE_WORKSPACES_JSON: JSON.stringify([directory]),
        COHALL_DEVICE_PROVIDERS: "codex",
        AUDIT_PID_FILE: pidPath,
        AUDIT_CLEANED_FILE: cleanedPath,
      },
    })
    const exited = once(worker, "exit")
    let providerPid: number | undefined
    try {
      await vi.waitFor(
        async () => {
          providerPid = Number(await readFile(pidPath, "utf8"))
          expect(Number.isSafeInteger(providerPid) && providerPid > 0).toBe(true)
        },
        { timeout: 10_000 },
      )
      worker.kill(signal)
      expect(await exited).toEqual([0, null])
      expect(await readFile(cleanedPath, "utf8")).toBe("done")
      const pid = providerPid
      if (pid === undefined) throw new Error("Missing provider PID")
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) {
        worker.kill("SIGKILL")
        await exited
      }
      if (providerPid !== undefined) {
        killProviderGroup(providerPid)
      }
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  },
)
