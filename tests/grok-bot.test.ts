import { TaskResult } from "../apps/device/src/delegation.ts"
import { StoredConfiguration } from "../apps/device/src/config.ts"
import { RelayClient, exchangePairing } from "../packages/client/src/index.ts"
import { BotId, TaskId, ThreadId } from "../packages/protocol/src/index.ts"
import { Effect, Schedule, Schema } from "effect"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createServer as createTcpServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { expect, it } from "vitest"

const executeFile = promisify(execFile)
const Prompt = Schema.Struct({
  agentId: BotId,
  prompt: Schema.String,
  clientNonce: TaskId,
  directAddressedAcceptance: Schema.Literal(true),
})

const stop = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  const timeout = setTimeout(() => child.kill("SIGKILL"), 2_000)
  child.kill("SIGTERM")
  await exited.finally(() => clearTimeout(timeout))
}

const availablePort = async (): Promise<number> => {
  const server = createTcpServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (address === null || typeof address === "string") throw new Error("Missing test port")
  return address.port
}

it("routes native bot replies, same-device Codex delegation, and follow-ups through the real CLI", async () => {
  const root = process.cwd()
  const directory = await mkdtemp(join(tmpdir(), "cohall-native-bots-"))
  const children: Array<ChildProcess> = []
  const nativeRuns: Array<Promise<void>> = []
  const errors: Array<unknown> = []
  const prompts: Array<typeof Prompt.Type> = []
  const accepted = new Set<TaskId>()
  const childTasks: Array<TaskResult> = []
  const gatewayToken = "fixture-native-gateway-token"
  const configPath = join(directory, "worker.json")
  const gatewayPath = join(directory, "gateway.json")
  const bin = join(directory, "bin")
  const baseEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("COHALL_")),
  )
  const workerEnvironment = {
    ...baseEnvironment,
    PATH: `${bin}:${baseEnvironment.PATH ?? ""}`,
    COHALL_CONFIG: configPath,
  }
  const run = async (args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) => {
    const output = await executeFile("node", ["bin/cohall.js", ...args], {
      cwd: root,
      env,
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    })
    return output.stdout
  }
  const taskResult = (output: string) => Schema.decodeUnknownSync(TaskResult)(JSON.parse(output))
  const nativeReply = async (input: typeof Prompt.Type) => {
    const threadId = Schema.decodeUnknownSync(ThreadId)(
      /Thread: ([0-9a-f-]+)\. Task:/.exec(input.prompt)?.[1],
    )
    expect(input.prompt).toContain(`cohall reply ${input.clientNonce}`)
    expect(input.prompt).toContain(`--parent ${input.clientNonce}`)
    for (const command of ["devices", "delegate", "reply"]) {
      expect(input.prompt).toContain(`COHALL_CONFIG='${configPath}' cohall ${command}`)
    }
    let answer = input.agentId === "writer-id" ? "Writer replied." : "Research follow-up received."
    if (input.agentId === "research-id" && childTasks.length === 0) {
      const child = taskResult(
        await run(
          [
            "delegate",
            "--target",
            "@cloud",
            "--provider",
            "codex",
            "--thread",
            threadId,
            "--parent",
            input.clientNonce,
            "--workspace",
            root,
            "--prompt",
            "Implement the research task",
            "--timeout",
            "10",
          ],
          workerEnvironment,
        ),
      )
      childTasks.push(child)
      expect(child).toMatchObject({ status: "completed", result: "Codex child finished." })
      answer = `Research delegated: ${child.result}`
    }
    const answerPath = join(directory, `${input.clientNonce}.txt`)
    await writeFile(answerPath, answer)
    await run(["reply", input.clientNonce, "--message-file", answerPath], workerEnvironment)
  }
  const gateway = createServer((request, response) => {
    const handle = async () => {
      expect(request.headers.authorization).toBe(`Bearer ${gatewayToken}`)
      response.setHeader("content-type", "application/json")
      let body = ""
      for await (const chunk of request) body += String(chunk)
      if (request.url === "/api/listAgents") {
        response.end(
          JSON.stringify([
            { id: "research-id", name: "Research", harness: "temporal", isRunning: true },
            { id: "writer-id", name: "Writer", isHiddenFromSidebar: true, isRunning: true },
          ]),
        )
        return
      }
      if (request.url === "/api/promptAcceptanceStatus") {
        const { clientNonce } = Schema.decodeUnknownSync(Schema.Struct({ clientNonce: TaskId }))(
          JSON.parse(body),
        )
        response.end(
          JSON.stringify(
            accepted.has(clientNonce)
              ? { outcome: "found", record: { status: "accepted" } }
              : { outcome: "not-found" },
          ),
        )
        return
      }
      if (request.url !== "/api/sendPrompt") throw new Error("Unexpected gateway method")
      const input = Schema.decodeUnknownSync(Prompt)(JSON.parse(body))
      expect(input.prompt).not.toContain(gatewayToken)
      expect(accepted.has(input.clientNonce)).toBe(false)
      prompts.push(input)
      accepted.add(input.clientNonce)
      response.end(JSON.stringify({ accepted: true }))
      nativeRuns.push(
        nativeReply(input).catch(async (cause: unknown) => {
          errors.push(cause)
          await run(
            ["reply", input.clientNonce, "--error", "Native fixture failed"],
            workerEnvironment,
          ).catch((replyError: unknown) => {
            errors.push(replyError)
          })
        }),
      )
    }
    void handle().catch((cause: unknown) => {
      errors.push(cause)
      response.writeHead(500).end()
    })
  })
  try {
    await mkdir(bin)
    const codex = join(bin, "codex")
    await writeFile(
      codex,
      `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
readFileSync(0, 'utf8');
console.log(JSON.stringify({ type: 'thread.started', thread_id: '22222222-2222-4222-8222-222222222222' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Codex child finished.' } }));
`,
    )
    await chmod(codex, 0o755)
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve))
    const gatewayAddress = gateway.address()
    if (gatewayAddress === null || typeof gatewayAddress === "string")
      throw new Error("Missing gateway port")
    await writeFile(
      gatewayPath,
      JSON.stringify({
        port: gatewayAddress.port,
        host: "127.0.0.1",
        token: gatewayToken,
      }),
      { mode: 0o600 },
    )
    const relayPort = await availablePort()
    const relayUrl = `http://127.0.0.1:${relayPort}`
    const ownerToken = "native-bot-test-owner".padEnd(64, "0")
    children.push(
      spawn("node", ["bin/cohall.js", "relay"], {
        cwd: root,
        env: {
          ...baseEnvironment,
          COHALL_CONFIG: join(directory, "relay-config.json"),
          COHALL_DATA_DIR: join(directory, "relay"),
          COHALL_RELAY_PORT: String(relayPort),
          COHALL_TOKEN: ownerToken,
        },
        stdio: "ignore",
      }),
    )
    await Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          fetch(`${relayUrl}/api/health`)
            .then((value) => value.ok)
            .catch(() => false),
        catch: (cause) => cause,
      }).pipe(
        Effect.repeat({ until: Boolean, schedule: Schedule.spaced("50 millis") }),
        Effect.timeout("10 seconds"),
      ),
    )
    const owner = RelayClient.make({ baseUrl: relayUrl, token: ownerToken })
    const pairing = await Effect.runPromise(
      owner.createPairing({ label: "Cloud", roles: ["client", "device"] }),
    )
    const paired = await Effect.runPromise(exchangePairing(relayUrl, { token: pairing.token }))
    const clientCredential = paired.credentials.find((value) => value.session.role === "client")
    const deviceCredential = paired.credentials.find((value) => value.session.role === "device")
    const deviceId = deviceCredential?.session.deviceId
    if (
      clientCredential === undefined ||
      deviceCredential === undefined ||
      deviceId === undefined
    ) {
      throw new Error("Missing test worker credentials")
    }
    const configuration = StoredConfiguration.make({
      version: 1,
      relayUrl,
      deviceId,
      deviceName: "cloud",
      workspaces: [root],
      clientToken: clientCredential.token,
      deviceToken: deviceCredential.token,
      providers: ["codex", "grok-bot"],
      grokGateway: gatewayPath,
    })
    await writeFile(configPath, JSON.stringify(configuration), { mode: 0o600 })
    children.push(
      spawn("node", ["bin/cohall.js", "device"], {
        cwd: root,
        env: workerEnvironment,
        stdio: "ignore",
      }),
    )
    await Effect.runPromise(
      owner.devices().pipe(
        Effect.repeat({
          until: (devices) =>
            devices.some((device) => device.id === deviceId && device.bots?.length === 2),
          schedule: Schedule.spaced("50 millis"),
        }),
        Effect.timeout("10 seconds"),
      ),
    )
    const callerPairing = await Effect.runPromise(
      owner.createPairing({ label: "Laptop", roles: ["client"] }),
    )
    const caller = await Effect.runPromise(
      exchangePairing(relayUrl, { token: callerPairing.token }),
    )
    const callerToken = caller.credentials.find((value) => value.session.role === "client")?.token
    if (callerToken === undefined) throw new Error("Missing test caller credential")
    const callerEnvironment = {
      ...baseEnvironment,
      COHALL_CONFIG: join(directory, "caller.json"),
      COHALL_RELAY_URL: relayUrl,
      COHALL_CLIENT_TOKEN: callerToken,
    }
    const roster = await run(["bots"], callerEnvironment)
    expect(JSON.parse(roster)).toEqual([
      {
        id: "research-id",
        name: "Research",
        device_id: deviceId,
        device_name: "cloud",
        status: "online",
        target: `@${deviceId}/research-id`,
      },
      {
        id: "writer-id",
        name: "Writer",
        device_id: deviceId,
        device_name: "cloud",
        status: "online",
        target: `@${deviceId}/writer-id`,
      },
    ])
    expect(roster).not.toContain(gatewayToken)
    const research = taskResult(
      await run(["send", "@Research", "Find a project", "--timeout", "15"], callerEnvironment),
    )
    expect(research).toMatchObject({
      status: "completed",
      provider: "grok-bot",
      bot_id: "research-id",
      result: "Research delegated: Codex child finished.",
    })
    expect(childTasks).toHaveLength(1)
    const context = await Effect.runPromise(owner.threadContext(research.thread_id))
    expect(context.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: childTasks[0]?.task_id,
          parentTaskId: research.task_id,
          provider: "codex",
          targetDeviceId: deviceId,
        }),
      ]),
    )
    const followup = taskResult(
      await run(
        ["send", "--thread", research.thread_id, "Expand the idea", "--timeout", "15"],
        callerEnvironment,
      ),
    )
    expect(followup).toMatchObject({
      status: "completed",
      thread_id: research.thread_id,
      bot_id: "research-id",
      result: "Research follow-up received.",
    })
    const writer = taskResult(
      await run(["send", "@Writer", "Draft an outline", "--timeout", "15"], callerEnvironment),
    )
    expect(writer).toMatchObject({
      status: "completed",
      bot_id: "writer-id",
      result: "Writer replied.",
    })
    await Promise.all(nativeRuns)
    expect(prompts.map((prompt) => prompt.clientNonce)).toEqual([
      research.task_id,
      followup.task_id,
      writer.task_id,
    ])
    expect(errors).toEqual([])
  } finally {
    await Promise.all(nativeRuns)
    for (const child of children.reverse()) await stop(child)
    gateway.closeAllConnections()
    await new Promise<void>((resolve) => gateway.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}, 45_000)
