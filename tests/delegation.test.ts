import { RelayClient } from "../packages/client/src/index.ts"
import { DeviceId, isTerminalTask } from "../packages/protocol/src/index.ts"
import { Effect, Schedule } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { spawn, type ChildProcess } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

const children: Array<ChildProcess> = []
const directories: Array<string> = []

const port = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close()
        reject(new Error("Could not reserve a test port"))
        return
      }
      server.close(() => resolve(address.port))
    })
  })

const stop = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null) {
    return
  }
  child.kill("SIGTERM")
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ])
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(stop))
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe("device delegation", () => {
  it("routes work through the relay and resumes the device Codex session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cohall-e2e-"))
    directories.push(directory)
    const bin = join(directory, "bin")
    const fakeLog = join(directory, "codex-args.log")
    await mkdir(bin, { recursive: true })
    const fakeCodex = join(bin, "codex")
    await writeFile(
      fakeCodex,
      `#!/usr/bin/env bash
read -r prompt
printf 'thread=%s args=%s\\n' "$COHALL_THREAD_ID" "$*" >> "$COHALL_FAKE_LOG"
sleep 0.2
printf '%s\\n' '{"type":"thread.started","thread_id":"22222222-2222-4222-8222-222222222222"}'
printf '%s\\n' '{"type":"item.started","item":{"id":"cmd","type":"command_execution","command":"printf test","status":"in_progress"}}'
printf '%s\\n' '{"type":"item.completed","item":{"id":"cmd","type":"command_execution","command":"printf test","aggregated_output":"checked local environment","status":"completed","exit_code":0}}'
printf '%s\\n' '{"type":"item.completed","item":{"id":"answer","type":"agent_message","text":"Remote device completed the delegated work."}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":8}}'
`,
    )
    await chmod(fakeCodex, 0o755)

    const relayPort = await port()
    const token = "integration-token"
    const relayUrl = `http://127.0.0.1:${relayPort}`
    const root = process.cwd()
    const relay = spawn("bun", ["apps/relay/src/main.ts"], {
      cwd: root,
      env: {
        ...process.env,
        COHALL_DATA_DIR: join(directory, "relay"),
        COHALL_RELAY_PORT: String(relayPort),
        COHALL_TOKEN: token,
      },
      stdio: "ignore",
    })
    children.push(relay)
    const client = RelayClient.make({ baseUrl: relayUrl, token })

    await Effect.runPromise(
      client
        .bootstrap()
        .pipe(Effect.retry(Schedule.spaced("100 millis")), Effect.timeout("10 seconds")),
    )
    const preflight = await fetch(`${relayUrl}/api/bootstrap`, {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:5173",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173")
    const rejectedPreflight = await fetch(`${relayUrl}/api/bootstrap`, {
      method: "OPTIONS",
      headers: {
        origin: "https://untrusted.example",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    })
    expect(rejectedPreflight.status).toBe(403)

    const deviceId = DeviceId.make("11111111-1111-4111-8111-111111111111")
    const device = spawn("bun", ["apps/device/src/main.ts", "device"], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        COHALL_FAKE_LOG: fakeLog,
        COHALL_DEVICE_ID: deviceId,
        COHALL_DEVICE_NAME: "test-device",
        COHALL_DEVICE_WORKSPACES: root,
        COHALL_RELAY_URL: relayUrl,
        COHALL_TOKEN: token,
        COHALL_CODEX_SANDBOX: "workspace-write",
      },
      stdio: "ignore",
    })
    children.push(device)

    await Effect.runPromise(
      client.devices().pipe(
        Effect.repeat({
          until: (devices) =>
            devices.some((known) => known.id === deviceId && known.status === "online"),
          schedule: Schedule.spaced("100 millis"),
        }),
        Effect.timeout("10 seconds"),
      ),
    )

    const mcp = new McpClient({
      name: "cohall-integration-test",
      version: "0.1.0",
    })
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["apps/device/src/main.ts", "mcp"],
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        COHALL_DEVICE_ID: deviceId,
        COHALL_DEVICE_NAME: "test-client",
        COHALL_DEVICE_WORKSPACES: root,
        COHALL_RELAY_URL: relayUrl,
        COHALL_TOKEN: token,
      },
      stderr: "ignore",
    })
    await mcp.connect(transport)
    const tools = await mcp.listTools()
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "list_devices",
      "delegate",
      "task_status",
      "cancel_task",
      "thread_context",
    ])
    await mcp.close()

    const first = await Effect.runPromise(
      client.createTask({
        prompt: "Inspect the local environment",
        targetDeviceId: deviceId,
        workspace: root,
      }),
    )
    const second = await Effect.runPromise(
      client.createTask({
        threadId: first.threadId,
        prompt: "Continue in the same remote session",
        targetDeviceId: deviceId,
        workspace: root,
      }),
    )
    expect(second.providerSessionId).toBeUndefined()

    const completed = await Effect.runPromise(
      client.getTask(first.id).pipe(
        Effect.repeat({
          until: isTerminalTask,
          schedule: Schedule.spaced("100 millis"),
        }),
        Effect.timeout("10 seconds"),
      ),
    )
    expect(completed.status).toBe("completed")
    expect(completed.result).toBe("Remote device completed the delegated work.")
    expect(completed.providerSessionId).toBe("22222222-2222-4222-8222-222222222222")
    expect((await Effect.runPromise(client.cancelTask(first.id))).status).toBe("completed")

    const continued = await Effect.runPromise(
      client.getTask(second.id).pipe(
        Effect.repeat({
          until: isTerminalTask,
          schedule: Schedule.spaced("100 millis"),
        }),
        Effect.timeout("10 seconds"),
      ),
    )
    expect(continued.status).toBe("completed")
    expect(continued.providerSessionId).toBe("22222222-2222-4222-8222-222222222222")

    const snapshot = await Effect.runPromise(client.bootstrap())
    expect(
      snapshot.messages.some(
        (message) =>
          message.taskId === first.id &&
          message.role === "agent" &&
          message.content === "Remote device completed the delegated work.",
      ),
    ).toBe(true)
    const log = await readFile(fakeLog, "utf8")
    const lines = log.trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain(`thread=${first.threadId}`)
    expect(lines[0]).toContain("--sandbox workspace-write")
    expect(lines[1]).toContain(`thread=${first.threadId}`)
    expect(lines[1]).toContain("args=exec resume --json")
    expect(lines[1]).not.toContain("--sandbox")
  }, 30_000)
})
