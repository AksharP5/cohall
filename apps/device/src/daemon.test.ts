import {
  DeviceId,
  BotId,
  DeviceOperation,
  OperationId,
  Task,
  makeTaskId,
  makeThreadId,
  maxSocketPayloadBytes,
  now,
} from "@cohall/protocol"
import { Effect } from "effect"
import * as Providers from "@cohall/providers"
import { type AddressInfo } from "node:net"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocketServer } from "ws"
import { DeviceConfiguration } from "./config.ts"
import { performDeviceOperation, runDaemon } from "./daemon.ts"
import type { UpgradeOptions, UpgradeResult } from "./upgrade.ts"
import * as Upgrades from "./upgrade.ts"
import * as Grok from "./grok-bot.ts"

const servers: Array<WebSocketServer> = []
const controllers: Array<AbortController> = []

const startServer = async (): Promise<{
  readonly server: WebSocketServer
  readonly relayUrl: string
}> => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  servers.push(server)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const address = server.address() as AddressInfo
  return { server, relayUrl: `http://127.0.0.1:${address.port}` }
}

const run = (relayUrl: string, grokGateway?: string): Promise<void> => {
  const controller = new AbortController()
  controllers.push(controller)
  const configuration = DeviceConfiguration.make({
    relayUrl,
    token: "device-token",
    id: DeviceId.make("11111111-1111-4111-8111-111111111111"),
    name: "test-device",
    workspaces: [process.cwd()],
    ...(grokGateway === undefined ? {} : { grokGateway }),
  })
  return Effect.runPromise(runDaemon(configuration), { signal: controller.signal }).catch(() => {})
}

afterEach(async () => {
  for (const controller of controllers.splice(0)) {
    controller.abort()
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) {
            client.terminate()
          }
          server.close(() => resolve())
        }),
    ),
  )
  vi.restoreAllMocks()
})

describe("device relay connection", () => {
  it("replays the completed result and file after reconnecting", async () => {
    const { server, relayUrl } = await startServer()
    const task = Task.make({
      id: makeTaskId(),
      threadId: makeThreadId(),
      targetDeviceId: DeviceId.make("11111111-1111-4111-8111-111111111111"),
      prompt: "Return a report file",
      provider: "codex",
      status: "assigned",
      createdAt: now(),
      updatedAt: now(),
    })
    let disconnected = false
    let finishProvider: (() => void) | undefined
    vi.spyOn(Providers, "run").mockImplementation((options) =>
      Effect.promise(async () => {
        await new Promise<void>((resolve) => {
          finishProvider = resolve
          if (disconnected) resolve()
        })
        const output = options.prompt.match(/^Output directory: (.+)$/m)?.[1]
        if (output === undefined) throw new Error("Missing output directory")
        await writeFile(join(output, "report.txt"), "answer")
        return { result: "Done" }
      }),
    )
    let connections = 0
    const finished: Array<{
      readonly result: string
      readonly attachments?: ReadonlyArray<{ readonly name: string; readonly data: string }>
    }> = []
    server.on("connection", (socket) => {
      connections += 1
      const first = connections === 1
      socket.once("message", () =>
        socket.send(
          JSON.stringify({
            _tag: "Connected",
            serverVersion: "test",
            connectedAt: now(),
            taskAttachments: true,
          }),
        ),
      )
      socket.on("close", () => {
        if (first) {
          disconnected = true
          finishProvider?.()
        }
      })
      socket.on("message", (message) => {
        const event = JSON.parse(message.toString()) as {
          readonly _tag: string
          readonly result?: string
          readonly attachments?: ReadonlyArray<{ readonly name: string; readonly data: string }>
        }
        if (first && event._tag === "DeviceHello") {
          socket.send(JSON.stringify({ _tag: "TaskAssigned", task }))
        }
        if (first && event._tag === "TaskAccepted") {
          socket.close()
        }
        if (!first && event._tag === "TaskFinished" && event.result !== undefined) {
          finished.push({
            result: event.result,
            ...(event.attachments === undefined ? {} : { attachments: event.attachments }),
          })
          socket.send(JSON.stringify({ _tag: "TaskSettled", taskId: task.id }))
        }
      })
    })
    void run(relayUrl)
    await vi.waitFor(() => expect(finished).toHaveLength(1), { timeout: 8_000 })
    expect(finished[0]).toEqual({
      result: "Done",
      attachments: [{ name: "report.txt", data: Buffer.from("answer").toString("base64") }],
    })
  })

  it("preserves the text result when maximum files exceed the socket budget", async () => {
    const { server, relayUrl } = await startServer()
    const task = Task.make({
      id: makeTaskId(),
      threadId: makeThreadId(),
      targetDeviceId: DeviceId.make("11111111-1111-4111-8111-111111111111"),
      prompt: "Return files",
      provider: "codex",
      status: "assigned",
      createdAt: now(),
      updatedAt: now(),
    })
    vi.spyOn(Providers, "run").mockImplementation((options) =>
      Effect.promise(async () => {
        const output = options.prompt.match(/^Output directory: (.+)$/m)?.[1]
        if (output === undefined) throw new Error("Missing output directory")
        await Promise.all([
          writeFile(join(output, "one.bin"), Buffer.alloc(256 * 1024)),
          writeFile(join(output, "two.bin"), Buffer.alloc(256 * 1024)),
        ])
        return { result: "界".repeat(131_072) }
      }),
    )
    const finished: Array<{
      readonly result: string
      readonly attachments?: unknown
      readonly bytes: number
    }> = []
    server.once("connection", (socket) => {
      socket.once("message", () =>
        socket.send(
          JSON.stringify({
            _tag: "Connected",
            serverVersion: "test",
            connectedAt: now(),
            taskAttachments: true,
          }),
        ),
      )
      socket.on("message", (message) => {
        const event = JSON.parse(message.toString()) as {
          readonly _tag: string
          readonly result?: string
          readonly attachments?: unknown
        }
        if (event._tag === "DeviceHello")
          socket.send(JSON.stringify({ _tag: "TaskAssigned", task }))
        if (event._tag === "TaskFinished" && event.result !== undefined) {
          finished.push({
            result: event.result,
            attachments: event.attachments,
            bytes: Buffer.byteLength(message.toString()),
          })
        }
      })
    })
    void run(relayUrl)
    await vi.waitFor(() => expect(finished).toHaveLength(1))
    expect(finished[0]?.result).toContain("Output files omitted")
    expect(finished[0]?.result).toContain("界")
    expect(finished[0]?.attachments).toBeUndefined()
    expect(finished[0]?.bytes).toBeLessThan(maxSocketPayloadBytes)
  })

  it("does not invite file output when an older relay omits attachment support", async () => {
    const { server, relayUrl } = await startServer()
    const task = Task.make({
      id: makeTaskId(),
      threadId: makeThreadId(),
      targetDeviceId: DeviceId.make("11111111-1111-4111-8111-111111111111"),
      prompt: "Answer",
      provider: "codex",
      status: "assigned",
      createdAt: now(),
      updatedAt: now(),
    })
    let prompt = ""
    vi.spyOn(Providers, "run").mockImplementation((options) =>
      Effect.sync(() => {
        prompt = options.prompt
        return { result: "Done" }
      }),
    )
    const finished: Array<{ readonly result?: string; readonly attachments?: unknown }> = []
    server.once("connection", (socket) => {
      socket.once("message", () =>
        socket.send(
          JSON.stringify({ _tag: "Connected", serverVersion: "old", connectedAt: now() }),
        ),
      )
      socket.on("message", (message) => {
        const event = JSON.parse(message.toString()) as {
          readonly _tag: string
          readonly result?: string
          readonly attachments?: unknown
        }
        if (event._tag === "DeviceHello")
          socket.send(JSON.stringify({ _tag: "TaskAssigned", task }))
        if (event._tag === "TaskFinished") finished.push(event)
      })
    })
    void run(relayUrl)
    await vi.waitFor(() => expect(finished).toHaveLength(1))
    expect(prompt).not.toContain("Output directory:")
    expect(finished[0]).toMatchObject({ result: "Done" })
    expect(finished[0]?.attachments).toBeUndefined()
  })

  it("registers before slow bot discovery and then publishes the roster", async () => {
    const { server, relayUrl } = await startServer()
    const bots = [{ id: BotId.make("bot-a"), name: "Research" }]
    let finishDiscovery: ((value: typeof bots) => void) | undefined
    vi.spyOn(Grok, "discoverGrokBots").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishDiscovery = resolve
        }),
    )
    const events: Array<{ _tag: string; device?: { bots: unknown }; bots?: unknown }> = []
    server.once("connection", (socket) => {
      socket.once("message", () =>
        socket.send(
          JSON.stringify({
            _tag: "Connected",
            serverVersion: "test",
            connectedAt: now(),
          }),
        ),
      )
      socket.on("message", (message) => {
        events.push(JSON.parse(message.toString()))
      })
    })
    void run(relayUrl, "/fake/gateway.json")
    await vi.waitFor(() => expect(events.some((event) => event._tag === "DeviceHello")).toBe(true))
    expect(events.find((event) => event._tag === "DeviceHello")?.device?.bots).toEqual([])
    finishDiscovery?.(bots)
    await vi.waitFor(() =>
      expect(events.find((event) => event._tag === "DeviceHeartbeat")?.bots).toEqual(bots),
    )
  })

  it("lets bots delegate to the CLI while serializing each bot and waiting to upgrade", async () => {
    const { server, relayUrl } = await startServer()
    const started: Array<string> = []
    const finish = new Map<string, () => void>()
    const botA = BotId.make("bot-a")
    const botB = BotId.make("bot-b")
    vi.spyOn(Grok, "discoverGrokBots").mockResolvedValue([
      { id: botA, name: "Research" },
      { id: botB, name: "Video" },
    ])
    vi.spyOn(Grok, "runGrokBot").mockImplementation((_path, task) => {
      started.push(task.prompt)
      return new Promise((resolve) => finish.set(task.prompt, () => resolve({ result: "done" })))
    })
    vi.spyOn(Providers, "run").mockImplementation((options) =>
      Effect.promise(() => {
        const name = options.prompt.includes("cli-one") ? "cli-one" : "cli-two"
        started.push(name)
        return new Promise((resolve) => finish.set(name, () => resolve({ result: "done" })))
      }),
    )
    const upgrade = vi.spyOn(Upgrades, "upgrade").mockRejectedValue(new Error("test upgrade"))
    const makeTask = (prompt: string, botId?: typeof botA): Task =>
      Task.make({
        id: makeTaskId(),
        threadId: makeThreadId(),
        targetDeviceId: DeviceId.make("11111111-1111-4111-8111-111111111111"),
        prompt,
        provider: botId === undefined ? "codex" : "grok-bot",
        ...(botId === undefined ? {} : { botId }),
        status: "assigned",
        createdAt: now(),
        updatedAt: now(),
      })
    const assigned = [
      makeTask("bot-a-one", botA),
      makeTask("bot-a-two", botA),
      makeTask("bot-b-one", botB),
      makeTask("cli-one"),
      makeTask("cli-two"),
    ]
    server.once("connection", (socket) => {
      socket.once("message", () =>
        socket.send(
          JSON.stringify({ _tag: "Connected", serverVersion: "test", connectedAt: now() }),
        ),
      )
      socket.on("message", (message) => {
        const event = JSON.parse(message.toString()) as {
          _tag: string
          bots?: ReadonlyArray<unknown>
        }
        if (event._tag !== "DeviceHeartbeat" || event.bots?.length !== 2) {
          return
        }
        for (const task of assigned) {
          socket.send(JSON.stringify({ _tag: "TaskAssigned", task }))
        }
        socket.send(
          JSON.stringify({
            _tag: "OperationAssigned",
            operation: {
              id: OperationId.make("66666666-6666-4666-8666-666666666666"),
              kind: "upgrade",
              status: "assigned",
              targetDeviceId: assigned[0]?.targetDeviceId,
              requestedVersion: "latest",
              restart: true,
              createdAt: now(),
              updatedAt: now(),
            },
          }),
        )
      })
    })
    void run(relayUrl, "/fake/gateway.json")
    await vi.waitFor(() => expect(started).toHaveLength(3))
    expect(started).toEqual(expect.arrayContaining(["bot-a-one", "bot-b-one", "cli-one"]))
    expect(upgrade).not.toHaveBeenCalled()
    finish.get("cli-one")?.()
    finish.get("bot-a-one")?.()
    await vi.waitFor(() => expect(started).toHaveLength(5))
    expect(upgrade).not.toHaveBeenCalled()
    finish.get("cli-two")?.()
    finish.get("bot-a-two")?.()
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(upgrade).not.toHaveBeenCalled()
    finish.get("bot-b-one")?.()
    await vi.waitFor(() => expect(upgrade).toHaveBeenCalledOnce())
  })

  it("accepts a reconnect burst of distinct bots without closing the connection", async () => {
    const { server, relayUrl } = await startServer()
    const bots = Array.from({ length: 12 }, (_, index) => ({
      id: BotId.make(`bot-${index}`),
      name: `Bot ${index}`,
    }))
    vi.spyOn(Grok, "discoverGrokBots").mockResolvedValue(bots)
    vi.spyOn(Grok, "runGrokBot").mockResolvedValue({ result: "ready" })
    const finished: Array<string> = []
    let disconnected = false
    server.once("connection", (socket) => {
      socket.once("close", () => {
        disconnected = true
      })
      socket.once("message", () =>
        socket.send(
          JSON.stringify({
            _tag: "Connected",
            serverVersion: "test",
            connectedAt: now(),
          }),
        ),
      )
      socket.on("message", (message) => {
        const event = JSON.parse(message.toString()) as { _tag: string; taskId?: string }
        if (event._tag === "TaskFinished" && event.taskId !== undefined) {
          finished.push(event.taskId)
        }
        if (event._tag !== "DeviceHello") {
          return
        }
        for (const bot of bots) {
          socket.send(
            JSON.stringify({
              _tag: "TaskAssigned",
              task: Task.make({
                id: makeTaskId(),
                threadId: makeThreadId(),
                targetDeviceId: DeviceId.make("11111111-1111-4111-8111-111111111111"),
                prompt: "hello",
                provider: "grok-bot",
                botId: bot.id,
                status: "assigned",
                createdAt: now(),
                updatedAt: now(),
              }),
            }),
          )
        }
      })
    })
    void run(relayUrl, "/fake/gateway.json")
    await vi.waitFor(() => expect(finished).toHaveLength(bots.length))
    expect(disconnected).toBe(false)
  })

  it("rejects relay frames larger than the shared socket budget", async () => {
    const { server, relayUrl } = await startServer()
    const closed = new Promise<number>((resolve) => {
      server.once("connection", (socket) => {
        socket.once("message", () => socket.send(Buffer.alloc(maxSocketPayloadBytes + 1)))
        socket.once("close", resolve)
      })
    })

    void run(relayUrl)

    await expect(closed).resolves.toBe(1009)
  })
})

it("maps a typed upgrade operation to the built-in upgrader", async () => {
  let received: UpgradeOptions | undefined
  const result: UpgradeResult = {
    upgraded: true,
    from_version: "1.2.2",
    installed_version: "1.2.3",
    requested_version: "1.2.3",
    package_manager: "npm",
    services_restarted: ["systemd-user:cohall-device.service"],
    services_pending_restart: [],
    resumed_after_restart: false,
    dry_run: false,
  }
  const operation = DeviceOperation.make({
    id: OperationId.make("66666666-6666-4666-8666-666666666666"),
    kind: "upgrade",
    status: "assigned",
    targetDeviceId: DeviceId.make("11111111-1111-4111-8111-111111111111"),
    requestedVersion: "1.2.3",
    restart: true,
    createdAt: now(),
    updatedAt: now(),
  })

  await expect(
    performDeviceOperation(operation, "1.2.2", (options) => {
      received = options
      return Promise.resolve(result)
    }),
  ).resolves.toBe(JSON.stringify(result))
  expect(received).toEqual({
    currentVersion: "1.2.2",
    target: "1.2.3",
    restart: true,
    dryRun: false,
    delegated: true,
  })
})
