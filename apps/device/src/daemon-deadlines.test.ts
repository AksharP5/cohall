import {
  DeviceId,
  SocketEvent,
  Task,
  TaskRunId,
  Timestamp,
  makeTaskId,
  makeThreadId,
  now,
} from "@cohall/protocol"
import * as Providers from "@cohall/providers"
import { Effect, Schema } from "effect"
import { expect, it, vi } from "vitest"
import { WebSocketServer } from "ws"
import { DeviceConfiguration } from "./config.ts"
import { runDaemon } from "./daemon.ts"

it("stops a coding run at its deadline while disconnected and replays its acknowledgement", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("Missing server address")
  const deviceId = DeviceId.make(crypto.randomUUID())
  const task = Task.make({
    id: makeTaskId(),
    threadId: makeThreadId(),
    targetDeviceId: deviceId,
    runId: TaskRunId.make(crypto.randomUUID()),
    prompt: "Keep working",
    provider: "codex",
    status: "assigned",
    createdAt: now(),
    updatedAt: now(),
    expiresAt: Timestamp.make(new Date(Date.now() + 1_000).toISOString()),
  })
  const controller = new AbortController()
  let stopped = false
  let connections = 0
  const replayed: Array<SocketEvent> = []
  const provider = vi.spyOn(Providers, "run").mockImplementation(() =>
    Effect.never.pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          stopped = true
        }),
      ),
    ),
  )
  server.on("connection", (socket) => {
    connections += 1
    const first = connections === 1
    socket.once("message", () =>
      socket.send(
        JSON.stringify({
          _tag: "Connected",
          serverVersion: "test",
          connectedAt: now(),
          taskDeadlines: true,
        }),
      ),
    )
    socket.on("message", (message) => {
      const event = Schema.decodeUnknownSync(SocketEvent)(JSON.parse(message.toString()))
      if (first && event._tag === "DeviceHello")
        socket.send(JSON.stringify({ _tag: "TaskAssigned", task }))
      if (first && event._tag === "TaskAccepted") socket.close()
      if (!first && event._tag === "TaskCancelled") {
        replayed.push(event)
        socket.send(JSON.stringify({ _tag: "TaskSettled", taskId: task.id, runId: task.runId }))
      }
    })
  })
  const daemon = Effect.runPromise(
    runDaemon(
      DeviceConfiguration.make({
        relayUrl: `http://127.0.0.1:${address.port}`,
        token: "device-token",
        id: deviceId,
        name: "deadline-worker",
        workspaces: [process.cwd()],
      }),
    ),
    { signal: controller.signal },
  ).catch(() => {})
  try {
    await vi.waitFor(() => expect(stopped).toBe(true), { timeout: 1_800 })
    expect(connections).toBe(1)
    expect(provider).toHaveBeenCalledOnce()
    await vi.waitFor(
      () =>
        expect(replayed).toEqual([{ _tag: "TaskCancelled", taskId: task.id, runId: task.runId }]),
      { timeout: 5_000 },
    )
  } finally {
    controller.abort()
    await daemon
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    provider.mockRestore()
  }
}, 8_000)
