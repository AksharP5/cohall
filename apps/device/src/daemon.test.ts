import {
  DeviceId,
  Device,
  AttachmentName,
  BotId,
  DeviceOperation,
  OperationId,
  Task,
  TaskRunId,
  TaskProgressInput,
  RequestTaskInput,
  SocketEvent,
  makeTaskId,
  makeThreadId,
  maxSocketPayloadBytes,
  now,
} from "@cohall/protocol"
import { Effect, ManagedRuntime, Schema } from "effect"
import { RelayClient } from "@cohall/client"
import * as Providers from "@cohall/providers"
import { type AddressInfo } from "node:net"
import Filesystem from "node:fs/promises"
import { writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocketServer, type WebSocket } from "ws"
import { DeviceConfiguration } from "./config.ts"
import { allowedWorkspace, performDeviceOperation, runDaemon } from "./daemon.ts"
import type { UpgradeOptions, UpgradeResult } from "./upgrade.ts"
import * as Upgrades from "./upgrade.ts"
import * as Grok from "./grok-bot.ts"
import { RelayStore } from "../../relay/src/store.ts"

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

const run = (
  relayUrl: string,
  grokGateway?: string,
  providers?: DeviceConfiguration["providers"],
): Promise<void> => {
  const controller = new AbortController()
  controllers.push(controller)
  const configuration = DeviceConfiguration.make({
    relayUrl,
    token: "device-token",
    id: DeviceId.make("11111111-1111-4111-8111-111111111111"),
    name: "test-device",
    workspaces: [process.cwd()],
    ...(grokGateway === undefined ? {} : { grokGateway }),
    ...(providers === undefined ? {} : { providers }),
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
  syncBuiltinESMExports()
})

describe("device relay connection", () => {
  it("allows two-dot child names while rejecting parent directory escapes", async () => {
    const directory = await Filesystem.mkdtemp(join(tmpdir(), "cohall-workspace-boundary-"))
    const root = join(directory, "workspace")
    const child = join(root, "..project")
    const outside = join(directory, "outside")
    try {
      await Filesystem.mkdir(child, { recursive: true })
      await Filesystem.mkdir(outside)
      const canonicalRoot = await Filesystem.realpath(root)
      const canonicalChild = await Filesystem.realpath(child)
      const configuration = DeviceConfiguration.make({
        relayUrl: "http://127.0.0.1:1",
        token: "unused-test-token",
        id: DeviceId.make("11111111-1111-4111-8111-111111111111"),
        name: "worker",
        workspaces: [canonicalRoot],
      })
      await expect(allowedWorkspace(configuration, root)).resolves.toBe(canonicalRoot)
      await expect(allowedWorkspace(configuration, child)).resolves.toBe(canonicalChild)
      await expect(allowedWorkspace(configuration, directory)).rejects.toThrow(
        "outside this device's configured workspace roots",
      )
      await expect(allowedWorkspace(configuration, outside)).rejects.toThrow(
        "outside this device's configured workspace roots",
      )
    } finally {
      await Filesystem.rm(directory, { recursive: true, force: true })
    }
  })

  it.each(["codex", "grok-bot"] as const)(
    "rejects queued %s work when that provider was disabled before restarting",
    async (provider) => {
      const { server, relayUrl } = await startServer()
      vi.spyOn(Providers, "availableProviders").mockReturnValue(["codex", "claude-code"])
      const runner = vi.spyOn(Providers, "run").mockReturnValue(Effect.succeed({ result: "Done" }))
      const botRunner = vi.spyOn(Grok, "runGrokBot").mockResolvedValue({ result: "Done" })
      vi.spyOn(Grok, "discoverGrokBots").mockResolvedValue([])
      const queued = {
        id: makeTaskId(),
        threadId: makeThreadId(),
        targetDeviceId: DeviceId.make("11111111-1111-4111-8111-111111111111"),
        prompt: "Queued before the provider configuration changed",
        status: "assigned" as const,
        createdAt: now(),
        updatedAt: now(),
        runId: TaskRunId.make("11111111-1111-4111-8111-111111111111"),
      }
      const task = Task.make({
        ...queued,
        provider,
        ...(provider === "grok-bot" ? { botId: BotId.make("disabled-bot") } : {}),
      })
      const enabledTask = Task.make({
        ...queued,
        id: makeTaskId(),
        provider: "claude-code",
      })
      const events: Array<SocketEvent> = []
      server.on("connection", (socket) => {
        socket.on("message", (message) => {
          const event = Schema.decodeUnknownSync(SocketEvent)(JSON.parse(message.toString()))
          events.push(event)
          if (event._tag === "Authenticate") {
            socket.send(
              JSON.stringify({ _tag: "Connected", serverVersion: "test", connectedAt: now() }),
            )
          }
          if (event._tag === "DeviceHello") {
            socket.send(JSON.stringify({ _tag: "TaskAssigned", task }))
          }
          if (event._tag === "TaskFailed") {
            socket.send(JSON.stringify({ _tag: "TaskAssigned", task: enabledTask }))
          }
        })
      })
      void run(relayUrl, "/fake/gateway.json", ["claude-code"])
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({
            _tag: "TaskFailed",
            taskId: task.id,
            runId: task.runId,
            error: expect.stringContaining(`${provider} is not enabled on this device`),
          }),
        ),
      )
      expect(runner).not.toHaveBeenCalledWith(expect.objectContaining({ provider }))
      expect(botRunner).not.toHaveBeenCalled()
      expect(events).toContainEqual(
        expect.objectContaining({
          _tag: "DeviceHello",
          device: expect.objectContaining({ providers: ["claude-code"] }),
        }),
      )
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({ _tag: "TaskFinished", taskId: enabledTask.id, result: "Done" }),
        ),
      )
      expect(runner).toHaveBeenCalledOnce()
      expect(runner).toHaveBeenCalledWith(expect.objectContaining({ provider: "claude-code" }))
    },
  )

  it.each(["codex", "grok-bot"] as const)(
    "keeps %s clarification working after reconnecting an active turn",
    async (provider) => {
      const { server, relayUrl } = await startServer()
      const runtime = ManagedRuntime.make(RelayStore.layer(":memory:"))
      const store = await runtime.runPromise(RelayStore.Service)
      const target = Device.make({
        id: DeviceId.make("11111111-1111-4111-8111-111111111111"),
        name: "test-device",
        hostname: "localhost",
        platform: "linux",
        architecture: "x64",
        status: "online",
        providers: [provider],
        capabilities: [{ id: "task-clarification", label: "Clarification" }],
        workspaces: [],
        version: "test",
        lastSeenAt: now(),
        ...(provider === "grok-bot"
          ? { bots: [{ id: BotId.make("reconnect-bot"), name: "Reconnect" }] }
          : {}),
      })
      const result = Promise.withResolvers<Awaited<ReturnType<typeof Grok.runGrokBot>>>()
      const runner =
        provider === "codex"
          ? vi
              .spyOn(Providers, "run")
              .mockImplementation(() => Effect.promise(() => result.promise))
          : vi.spyOn(Grok, "runGrokBot").mockReturnValue(result.promise)
      vi.spyOn(Grok, "discoverGrokBots").mockResolvedValue(target.bots ?? [])
      const sockets: Array<WebSocket> = []
      const accepted: Array<SocketEvent> = []
      const terminal = Promise.withResolvers<Task>()
      let processing = Promise.resolve()
      try {
        await Effect.runPromise(store.upsertDevice(target))
        const task = await Effect.runPromise(
          store.createDelegation(
            {
              prompt: "Check which branch to use",
              provider,
              ...(provider === "grok-bot" ? { botId: BotId.make("reconnect-bot") } : {}),
            },
            target.id,
            "owner",
          ),
        )
        server.on("connection", (socket) => {
          sockets.push(socket)
          socket.on("message", (message) => {
            processing = processing
              .then(async () => {
                const event = Schema.decodeUnknownSync(SocketEvent)(JSON.parse(message.toString()))
                if (event._tag === "Authenticate") {
                  socket.send(
                    JSON.stringify({
                      _tag: "Connected",
                      serverVersion: "test",
                      connectedAt: now(),
                      taskClarification: true,
                    }),
                  )
                }
                if (event._tag === "DeviceHello") {
                  const assigned = await Effect.runPromise(store.assignTask(task.id))
                  socket.send(JSON.stringify({ _tag: "TaskAssigned", task: assigned }))
                }
                if (event._tag === "TaskAccepted") {
                  accepted.push(event)
                  await Effect.runPromise(store.acceptTask(task.id, target.id, event.runId))
                }
                if (event._tag === "TaskInputRequested") {
                  await Effect.runPromise(
                    store.requestTaskInput(task.id, target.id, {
                      runId: event.runId,
                      question: event.question,
                    }),
                  )
                }
                if (event._tag === "TaskFinished" || event._tag === "TaskInputRequested") {
                  terminal.resolve(
                    await Effect.runPromise(
                      store.finishTask(task.id, target.id, "", undefined, undefined, event.runId),
                    ),
                  )
                }
              })
              .catch((cause: unknown) => terminal.reject(cause))
          })
        })
        void run(relayUrl, provider === "grok-bot" ? "/fake/gateway.json" : undefined)
        await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce())
        await processing
        const original = await Effect.runPromise(store.getTask(task.id))
        expect(original.status).toBe("running")
        expect(original.startedAt).toBeDefined()
        const first = sockets[0]
        if (first === undefined) throw new Error("Missing first device connection")
        const closed = new Promise<void>((resolve) => first.once("close", () => resolve()))
        first.close()
        await closed
        await Effect.runPromise(store.requeueTasksFor(target.id))
        await vi.waitFor(() => expect(accepted).toHaveLength(2), { timeout: 8_000 })
        await processing
        const resumed = await Effect.runPromise(store.getTask(task.id))
        expect(resumed.status).toBe("running")
        expect(resumed.startedAt).toBe(original.startedAt)
        const trace = await Effect.runPromise(store.traceTask(task.id))
        expect(
          trace.events.filter((event) => event.kind === "running").map((event) => event.detail),
        ).toEqual([
          "Target device accepted the task and started the provider",
          "Target device accepted the task again",
        ])
        expect(runner).toHaveBeenCalledOnce()
        const input = Schema.decodeUnknownSync(RequestTaskInput)({
          runId: resumed.runId,
          question: "Which branch?",
        })
        if (provider === "codex") {
          const progress = Schema.decodeUnknownSync(TaskProgressInput)({
            note: "Checking the branch",
          })
          await expect(
            Effect.runPromise(store.reportTaskProgress(task.id, target.id, progress.note)),
          ).resolves.toMatchObject(progress)
          await Effect.runPromise(store.requestTaskInput(task.id, target.id, input))
          result.resolve({ result: "Asked the sender" })
        } else {
          result.resolve({ result: "", question: input.question })
        }
        expect(await terminal.promise).toMatchObject({
          status: "needs_input",
          clarifications: [{ question: input.question }],
        })
        expect(runner).toHaveBeenCalledOnce()
      } finally {
        await runtime.dispose()
      }
    },
  )

  it.each([
    { phase: "mkdir", stopping: "cancel" },
    { phase: "writeFile", stopping: "cancel" },
    { phase: "mkdir", stopping: "shutdown" },
    { phase: "writeFile", stopping: "shutdown" },
  ] as const)(
    "finishes $phase staging cleanup before $stopping completes",
    async ({ phase, stopping }) => {
      const { server, relayUrl } = await startServer()
      const staged = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const processed = Promise.withResolvers<void>()
      const disconnected = Promise.withResolvers<void>()
      const cancelled = Promise.withResolvers<boolean>()
      const connected = Promise.withResolvers<WebSocket>()
      let root: string | undefined
      const mkdir = Filesystem.mkdir
      const write = Filesystem.writeFile
      if (phase === "mkdir") {
        vi.spyOn(Filesystem, "mkdir").mockImplementation(async (path, options) => {
          if (typeof path === "string" && basename(path) === "input") {
            root = dirname(path)
            staged.resolve()
            await release.promise
          }
          return mkdir(path, options)
        })
      } else {
        vi.spyOn(Filesystem, "writeFile").mockImplementation(async (path, data, options) => {
          if (typeof path === "string" && basename(path) === "input.txt") {
            root = dirname(dirname(path))
            staged.resolve()
            await release.promise
          }
          return write(path, data, options)
        })
      }
      syncBuiltinESMExports()
      const makeClient = RelayClient.make
      vi.spyOn(RelayClient, "make").mockImplementation((options) => ({
        ...makeClient(options),
        readAttachment: () => Effect.succeed(new Uint8Array(Buffer.from("input"))),
      }))
      const provider = vi
        .spyOn(Providers, "run")
        .mockReturnValue(Effect.succeed({ result: "Done" }))
      vi.spyOn(console, "error").mockImplementation((message) => {
        if (message === "Relay error: Cancellation processed") processed.resolve()
      })
      const task = Task.make({
        id: makeTaskId(),
        threadId: makeThreadId(),
        targetDeviceId: DeviceId.make("11111111-1111-4111-8111-111111111111"),
        prompt: "Prepare files",
        provider: "codex",
        status: "assigned",
        runId: TaskRunId.make(crypto.randomUUID()),
        inputAttachmentNames: [AttachmentName.make("input.txt")],
        createdAt: now(),
        updatedAt: now(),
      })
      server.once("connection", (socket) => {
        connected.resolve(socket)
        socket.once("close", () => disconnected.resolve())
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
          const event = Schema.decodeUnknownSync(SocketEvent)(JSON.parse(message.toString()))
          if (event._tag === "DeviceHello")
            socket.send(JSON.stringify({ _tag: "TaskAssigned", task }))
          if (event._tag === "TaskCancelled") {
            expect(event.runId).toBe(task.runId)
            if (root === undefined) throw new Error("Missing staging root")
            void Filesystem.stat(root).then(
              () => cancelled.resolve(true),
              () => cancelled.resolve(false),
            )
          }
        })
      })
      let stopped = false
      const daemon = run(relayUrl).then(() => {
        stopped = true
      })
      try {
        await staged.promise
        if (stopping === "cancel") {
          const socket = await connected.promise
          socket.send(JSON.stringify({ _tag: "CancelTask", taskId: task.id, runId: task.runId }))
          socket.send(
            JSON.stringify({ _tag: "Error", code: "test", message: "Cancellation processed" }),
          )
          await processed.promise
          release.resolve()
          expect(await cancelled.promise).toBe(false)
        } else {
          const controller = controllers.at(-1)
          if (controller === undefined) throw new Error("Missing worker controller")
          controller.abort()
          await disconnected.promise
          expect(stopped).toBe(false)
          release.resolve()
          await daemon
        }
        if (root === undefined) throw new Error("Missing staging root")
        await expect(Filesystem.stat(root)).rejects.toMatchObject({ code: "ENOENT" })
        expect(provider).not.toHaveBeenCalled()
      } finally {
        release.resolve()
        controllers.at(-1)?.abort()
        await daemon
        if (root !== undefined) await Filesystem.rm(root, { recursive: true, force: true })
      }
    },
  )

  it("waits for provider cleanup during shutdown without starting queued work", async () => {
    const { server, relayUrl } = await startServer()
    const cleanup = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const disconnected = Promise.withResolvers<void>()
    const provider = vi.spyOn(Providers, "run").mockImplementation(() =>
      Effect.never.pipe(
        Effect.ensuring(
          Effect.promise(() => {
            cleanup.resolve()
            return release.promise
          }),
        ),
      ),
    )
    const upgrade = vi.spyOn(Upgrades, "upgrade").mockRejectedValue(new Error("test upgrade"))
    const task = Task.make({
      id: makeTaskId(),
      threadId: makeThreadId(),
      targetDeviceId: DeviceId.make("11111111-1111-4111-8111-111111111111"),
      prompt: "Active work",
      provider: "codex",
      status: "assigned",
      runId: TaskRunId.make(crypto.randomUUID()),
      createdAt: now(),
      updatedAt: now(),
    })
    server.once("connection", (socket) => {
      socket.once("close", () => disconnected.resolve())
      socket.once("message", () =>
        socket.send(
          JSON.stringify({ _tag: "Connected", serverVersion: "test", connectedAt: now() }),
        ),
      )
      socket.on("message", (message) => {
        const event = Schema.decodeUnknownSync(SocketEvent)(JSON.parse(message.toString()))
        if (event._tag !== "DeviceHello") return
        socket.send(JSON.stringify({ _tag: "TaskAssigned", task }))
        socket.send(
          JSON.stringify({
            _tag: "TaskAssigned",
            task: Task.make({ ...task, id: makeTaskId(), prompt: "Queued work" }),
          }),
        )
        socket.send(
          JSON.stringify({
            _tag: "OperationAssigned",
            operation: DeviceOperation.make({
              id: OperationId.make(crypto.randomUUID()),
              kind: "upgrade",
              status: "assigned",
              targetDeviceId: task.targetDeviceId,
              requestedVersion: "latest",
              restart: true,
              createdAt: now(),
              updatedAt: now(),
            }),
          }),
        )
      })
    })
    let stopped = false
    const stopping = run(relayUrl).then(() => {
      stopped = true
    })
    try {
      await vi.waitFor(() => expect(provider).toHaveBeenCalledOnce())
      const controller = controllers.at(-1)
      if (controller === undefined) throw new Error("Missing worker controller")
      controller.abort()
      await Promise.all([cleanup.promise, disconnected.promise])
      expect(stopped).toBe(false)
      expect(provider).toHaveBeenCalledOnce()
      expect(upgrade).not.toHaveBeenCalled()
    } finally {
      release.resolve()
      await stopping
    }
    expect(provider).toHaveBeenCalledOnce()
    expect(upgrade).not.toHaveBeenCalled()
  })

  it("replays each run's terminal event without restarting a cancelled turn", async () => {
    const { server, relayUrl } = await startServer()
    const old = Task.make({
      id: makeTaskId(),
      threadId: makeThreadId(),
      targetDeviceId: DeviceId.make("11111111-1111-4111-8111-111111111111"),
      prompt: "Old turn",
      provider: "codex",
      status: "assigned",
      runId: TaskRunId.make(crypto.randomUUID()),
      createdAt: now(),
      updatedAt: now(),
    })
    const resumedRunId = TaskRunId.make(crypto.randomUUID())
    const resumed = Task.make({
      ...old,
      runId: resumedRunId,
      prompt: "Resumed turn",
    })
    const other = Task.make({
      ...old,
      id: makeTaskId(),
      runId: TaskRunId.make(crypto.randomUUID()),
      prompt: "Other task",
    })
    const first = Promise.withResolvers<Providers.RunResult>()
    const provider = vi
      .spyOn(Providers, "run")
      .mockImplementation((options) =>
        options.prompt.includes("Old turn")
          ? Effect.promise(() => first.promise)
          : Effect.succeed({ result: "Other done" }),
      )
    const events: Array<SocketEvent> = []
    const connections: Array<Array<SocketEvent>> = []
    const reconnected = Promise.withResolvers<WebSocket>()
    server.on("connection", (socket) => {
      const received: Array<SocketEvent> = []
      connections.push(received)
      const firstConnection = connections.length === 1
      if (connections.length === 2) reconnected.resolve(socket)
      const send = (event: SocketEvent) => socket.send(JSON.stringify(event))
      socket.once("message", () =>
        send({
          _tag: "Connected",
          serverVersion: "test",
          connectedAt: now(),
          taskClarification: true,
        }),
      )
      socket.on("close", () => {
        if (firstConnection) first.resolve({ result: "Old done" })
      })
      socket.on("message", (message) => {
        const event = Schema.decodeUnknownSync(SocketEvent)(JSON.parse(message.toString()))
        events.push(event)
        received.push(event)
        if (!firstConnection) return
        if (event._tag === "DeviceHello") send({ _tag: "TaskAssigned", task: old })
        if (event._tag === "TaskAccepted" && event.taskId === old.id && event.runId === old.runId) {
          send({ _tag: "TaskAssigned", task: resumed })
          send({ _tag: "CancelTask", taskId: old.id, runId: resumedRunId })
        }
        if (event._tag === "TaskCancelled" && event.runId === resumedRunId) {
          socket.close()
        }
      })
    })
    void run(relayUrl)
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        _tag: "TaskCancelled",
        taskId: old.id,
        runId: resumedRunId,
      }),
    )
    await vi.waitFor(() => expect(provider).toHaveBeenCalledOnce())
    await vi.waitFor(
      () => {
        expect(connections[1]).toContainEqual({
          _tag: "TaskCancelled",
          taskId: old.id,
          runId: resumedRunId,
        })
        expect(connections[1]).toContainEqual({
          _tag: "TaskFinished",
          taskId: old.id,
          runId: old.runId,
          result: "Old done",
        })
      },
      { timeout: 8_000 },
    )
    const socket = await reconnected.promise
    socket.send(JSON.stringify({ _tag: "TaskSettled", taskId: old.id, runId: old.runId }))
    socket.send(JSON.stringify({ _tag: "TaskAssigned", task: resumed }))
    socket.send(JSON.stringify({ _tag: "TaskAssigned", task: other }))
    await vi.waitFor(() =>
      expect(
        events.some((event) => event._tag === "TaskFinished" && event.taskId === other.id),
      ).toBe(true),
    )
    expect(provider).toHaveBeenCalledTimes(2)
    expect(provider.mock.calls[1]?.[0].prompt).toContain("Other task")
    socket.close()
    await vi.waitFor(
      () =>
        expect(connections[2]).toContainEqual({
          _tag: "TaskFinished",
          taskId: other.id,
          runId: other.runId,
          result: "Other done",
        }),
      { timeout: 8_000 },
    )
    expect(connections[2]?.filter((event) => "taskId" in event && event.taskId === old.id)).toEqual(
      [{ _tag: "TaskCancelled", taskId: old.id, runId: resumedRunId }],
    )
    expect(provider).toHaveBeenCalledTimes(2)
  })

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
