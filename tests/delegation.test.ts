import { RelayClient, exchangePairing } from "../packages/client/src/index.ts"
import {
  Device,
  TaskTrace,
  isTerminalTask,
  type AuthSession,
  type Task,
} from "../packages/protocol/src/index.ts"
import { TaskResult } from "../apps/device/src/delegation.ts"
import { Effect, Schedule, Schema } from "effect"
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"

const children: Array<ChildProcess> = []
const directories: Array<string> = []
const executeFile = promisify(execFile)

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

const runCohall = async (
  root: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> => {
  const result = await executeFile("node", ["bin/cohall.js", ...args], {
    cwd: root,
    env,
    maxBuffer: 1024 * 1024,
  })
  return result.stdout
}

const waitForRelay = async (relayUrl: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${relayUrl}/api/health`).catch(() => undefined)
    if (response?.ok === true) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("Relay did not start")
}

const waitForTerminal = (client: ReturnType<typeof RelayClient.make>, task: Task) =>
  client.getTask(task.id).pipe(
    Effect.repeat({
      until: isTerminalTask,
      schedule: Schedule.spaced("50 millis"),
    }),
    Effect.timeout("10 seconds"),
  )

afterEach(async () => {
  await Promise.all(children.splice(0).map(stop))
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe("headless Cohall", () => {
  it("pairs, delegates through every provider, resumes, cancels, and revokes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cohall-e2e-"))
    directories.push(directory)
    const bin = join(directory, "bin")
    const fakeLog = join(directory, "provider-args.log")
    const configPath = join(directory, "config", "config.json")
    await mkdir(bin, { recursive: true })
    await writeFile(
      join(bin, "codex"),
      `#!/usr/bin/env bash
prompt=$(cat)
printf 'codex thread=%s args=%s\n' "$COHALL_THREAD_ID" "$*" >> "$PROVIDER_FAKE_LOG"
if [[ -n "$COHALL_TOKEN$COHALL_CLIENT_TOKEN$COHALL_DEVICE_TOKEN" ]]; then exit 86; fi
if [[ "$prompt" == *LONG_RUNNING* ]]; then sleep 20; fi
printf '%s\n' '{"type":"thread.started","thread_id":"22222222-2222-4222-8222-222222222222"}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Codex completed the delegated work."}}'
`,
    )
    await writeFile(
      join(bin, "claude"),
      `#!/usr/bin/env bash
printf 'claude thread=%s args=%s\n' "$COHALL_THREAD_ID" "$*" >> "$PROVIDER_FAKE_LOG"
printf '%s\n' '{"result":"Claude completed the delegated work.","session_id":"33333333-3333-4333-8333-333333333333"}'
`,
    )
    await writeFile(
      join(bin, "opencode"),
      `#!/usr/bin/env bash
prompt="\${!#}"
if [[ -n "$(cat)" ]]; then exit 87; fi
printf 'opencode thread=%s args=%s\n' "$COHALL_THREAD_ID" "$*" >> "$PROVIDER_FAKE_LOG"
if [[ "$prompt" == *OPEN_CODE_ERROR* ]]; then
  printf '%s\n' '{"type":"error","sessionID":"44444444-4444-4444-8444-444444444444","error":{"name":"ProviderAuthError","data":{"message":"OpenAI API key is missing."}}}'
  exit 0
fi
printf '%s\n' '{"type":"text","sessionID":"44444444-4444-4444-8444-444444444444","part":{"text":"OpenCode completed the delegated work."}}'
`,
    )
    await Promise.all(["codex", "claude", "opencode"].map((name) => chmod(join(bin, name), 0o755)))

    const relayPort = await port()
    const ownerToken = "integration-owner-token"
    const relayUrl = `http://127.0.0.1:${relayPort}`
    const root = process.cwd()
    const skill = await runCohall(root, ["skill"])
    expect(skill).toContain("# Cohall")
    expect(skill).toContain("Use the installed `cohall` executable when it is available")
    expect(skill).toContain("cohall delegate")
    expect(await runCohall(root, [])).toContain("cohall join")

    const relay = spawn("node", ["bin/cohall.js", "relay"], {
      cwd: root,
      env: {
        ...process.env,
        COHALL_DATA_DIR: join(directory, "relay"),
        COHALL_RELAY_PORT: String(relayPort),
        COHALL_TOKEN: ownerToken,
      },
      stdio: "ignore",
    })
    children.push(relay)
    await waitForRelay(relayUrl)
    const owner = RelayClient.make({ baseUrl: relayUrl, token: ownerToken })

    const ownerEnvironment = {
      ...process.env,
      COHALL_RELAY_URL: relayUrl,
      COHALL_TOKEN: ownerToken,
    }
    delete ownerEnvironment.COHALL_CLIENT_TOKEN
    const pairingJson: unknown = JSON.parse(
      await runCohall(root, ["pair", "--label", "Test machine"], ownerEnvironment),
    )
    const pairing = Schema.decodeUnknownSync(Schema.Struct({ pairing_token: Schema.String }))(
      pairingJson,
    )
    const paired = await Effect.runPromise(
      exchangePairing(relayUrl, { token: pairing.pairing_token }),
    )
    expect(paired.credentials.map((credential) => credential.session.role).sort()).toEqual([
      "client",
      "device",
    ])
    const credential = (role: "client" | "device") => {
      const found = paired.credentials.find((value) => value.session.role === role)
      if (found === undefined) {
        throw new Error(`Missing ${role} credential`)
      }
      return found
    }
    const clientCredential = credential("client")
    const deviceCredential = credential("device")
    const deviceId = deviceCredential.session.deviceId
    if (deviceId === undefined) {
      throw new Error("Device credential is not bound to a device")
    }
    expect(clientCredential.token).not.toBe(deviceCredential.token)
    await expect(
      Effect.runPromise(
        RelayClient.make({ baseUrl: relayUrl, token: deviceCredential.token }).devices(),
      ),
    ).rejects.toMatchObject({ status: 401 })
    await expect(
      Effect.runPromise(exchangePairing(relayUrl, { token: pairing.pairing_token })),
    ).rejects.toMatchObject({
      status: 401,
    })

    const joinPairing = await Effect.runPromise(
      owner.createPairing({ label: "CLI join", roles: ["client"] }),
    )
    const pairingTokenPath = join(directory, "pairing-token")
    await writeFile(pairingTokenPath, joinPairing.token, { mode: 0o600 })
    await runCohall(
      root,
      ["join", "--token-file", pairingTokenPath, "--relay", relayUrl, "--client-only"],
      {
        ...process.env,
        COHALL_CONFIG: configPath,
      },
    )
    expect((await stat(configPath)).mode & 0o777).toBe(0o600)
    const saved = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>
    expect(saved.clientToken).toBeTypeOf("string")
    expect(saved).not.toHaveProperty("deviceToken")

    const client = RelayClient.make({ baseUrl: relayUrl, token: clientCredential.token })
    const device = spawn("node", ["bin/cohall.js", "device"], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        PROVIDER_FAKE_LOG: fakeLog,
        COHALL_DEVICE_ID: deviceId,
        COHALL_DEVICE_NAME: "test-device",
        COHALL_DEVICE_WORKSPACES: root,
        COHALL_RELAY_URL: relayUrl,
        COHALL_DEVICE_TOKEN: deviceCredential.token,
        COHALL_TOKEN: ownerToken,
        COHALL_CLIENT_TOKEN: clientCredential.token,
        COHALL_SANDBOX: "workspace-write",
      },
      stdio: "ignore",
    })
    children.push(device)
    const known = await Effect.runPromise(
      client.devices().pipe(
        Effect.repeat({
          until: (devices) =>
            devices.some((value) => value.id === deviceId && value.status === "online"),
          schedule: Schedule.spaced("50 millis"),
        }),
        Effect.timeout("10 seconds"),
      ),
    )
    const advertised = known.find((value) => value.id === deviceId)
    expect(advertised?.providers).toEqual(["codex", "claude-code", "opencode"])

    const cliEnvironment = {
      ...process.env,
      COHALL_RELAY_URL: relayUrl,
      COHALL_CLIENT_TOKEN: clientCredential.token,
    }
    const listed: unknown = JSON.parse(await runCohall(root, ["devices"], cliEnvironment))
    expect(Schema.decodeUnknownSync(Schema.Array(Device))(listed)).toHaveLength(1)

    const mcp = new McpClient({ name: "cohall-test", version: "0.2.0" })
    const transport = new StdioClientTransport({
      command: "node",
      args: ["bin/cohall.js", "mcp"],
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        COHALL_RELAY_URL: relayUrl,
        COHALL_CLIENT_TOKEN: clientCredential.token,
      },
      stderr: "ignore",
    })
    await mcp.connect(transport)
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).toEqual([
      "list_devices",
      "delegate",
      "task_status",
      "task_trace",
      "wait_task",
      "cancel_task",
      "thread_context",
    ])
    await mcp.close()

    const rawQueued: unknown = JSON.parse(
      await runCohall(
        root,
        [
          "delegate",
          "--target",
          "test-device",
          "--workspace",
          root,
          "--no-wait",
          "--prompt",
          "Inspect the local environment",
        ],
        cliEnvironment,
      ),
    )
    const queued = Schema.decodeUnknownSync(TaskResult)(rawQueued)
    const completed = await Effect.runPromise(
      waitForTerminal(client, await Effect.runPromise(client.getTask(queued.task_id))),
    )
    expect(completed.result).toBe("Codex completed the delegated work.")
    expect(completed.providerSessionId).toBe("22222222-2222-4222-8222-222222222222")
    const rawTrace: unknown = JSON.parse(
      await runCohall(root, ["trace", queued.task_id], cliEnvironment),
    )
    const trace = Schema.decodeUnknownSync(TaskTrace)(rawTrace)
    expect(trace.events.map((event) => event.kind)).toEqual([
      "queued",
      "assigned",
      "running",
      "completed",
    ])
    expect(trace.targetDevice.name).toBe("test-device")
    expect(rawTrace).not.toHaveProperty("prompt")
    expect(rawTrace).not.toHaveProperty("result")
    expect(rawTrace).not.toHaveProperty("providerSessionId")
    const followedTrace: unknown = JSON.parse(
      await runCohall(root, ["trace", queued.task_id, "--follow"], cliEnvironment),
    )
    expect(Schema.decodeUnknownSync(TaskTrace)(followedTrace).status).toBe("completed")

    const continued = await Effect.runPromise(
      client.createTask({
        threadId: queued.thread_id,
        prompt: "Continue in the same session",
        provider: "codex",
        targetDeviceId: deviceId,
        workspace: root,
      }),
    )
    expect(continued.providerSessionId).toBe("22222222-2222-4222-8222-222222222222")
    expect((await Effect.runPromise(waitForTerminal(client, continued))).status).toBe("completed")

    const providerCases = [
      ["claude-code", "Claude completed the delegated work."],
      ["opencode", "OpenCode completed the delegated work."],
    ] as const
    for (const [provider, result] of providerCases) {
      const task = await Effect.runPromise(
        client.createTask({
          prompt: `Use ${provider}`,
          provider,
          targetDeviceId: deviceId,
          workspace: root,
        }),
      )
      expect((await Effect.runPromise(waitForTerminal(client, task))).result).toBe(result)
    }

    const openCodeError = await Effect.runPromise(
      client.createTask({
        prompt: "OPEN_CODE_ERROR",
        provider: "opencode",
        targetDeviceId: deviceId,
        workspace: root,
      }),
    )
    expect(await Effect.runPromise(waitForTerminal(client, openCodeError))).toMatchObject({
      status: "failed",
      error: "OpenCode ProviderAuthError: OpenAI API key is missing.",
    })

    const long = await Effect.runPromise(
      client.createTask({ prompt: "LONG_RUNNING", targetDeviceId: deviceId, workspace: root }),
    )
    const running = await Effect.runPromise(
      client.getTask(long.id).pipe(
        Effect.repeat({
          until: (task) => task.status === "running",
          schedule: Schedule.spaced("50 millis"),
        }),
        Effect.timeout("5 seconds"),
      ),
    )
    expect(running.status).toBe("running")
    expect((await Effect.runPromise(client.cancelTask(long.id))).status).toBe("cancelling")
    expect((await Effect.runPromise(waitForTerminal(client, long))).status).toBe("cancelled")
    expect(
      (await Effect.runPromise(client.traceTask(long.id))).events.map((event) => event.kind),
    ).toEqual(["queued", "assigned", "running", "cancelling", "cancelled"])

    const context = await Effect.runPromise(client.threadContext(queued.thread_id))
    expect(
      context.messages.some((message) => message.content === "Codex completed the delegated work."),
    ).toBe(true)
    const log = await readFile(fakeLog, "utf8")
    const codexLines = log.split("\n").filter((line) => line.startsWith("codex "))
    expect(codexLines[0]).toContain("--skip-git-repo-check")
    expect(codexLines[0]).toContain('sandbox_mode="workspace-write"')
    expect(codexLines[1]).toContain("exec resume")
    expect(codexLines[1]).toContain('sandbox_mode="workspace-write"')

    await Effect.runPromise(owner.revokeAuthSession(deviceCredential.session.id))
    const offline = await Effect.runPromise(
      client.devices().pipe(
        Effect.repeat({
          until: (devices) =>
            devices.some((value) => value.id === deviceId && value.status === "offline"),
          schedule: Schedule.spaced("50 millis"),
        }),
        Effect.timeout("5 seconds"),
      ),
    )
    expect(offline.find((value) => value.id === deviceId)?.status).toBe("offline")
    expect(await Effect.runPromise(client.devices())).toHaveLength(1)
    await Effect.runPromise(owner.revokeAuthSession(clientCredential.session.id))
    await expect(Effect.runPromise(client.devices())).rejects.toMatchObject({ status: 401 })

    const sessions: ReadonlyArray<AuthSession> = await Effect.runPromise(owner.authSessions())
    expect(sessions.filter((session) => session.label === "Test machine")).toHaveLength(2)
  }, 40_000)
})
