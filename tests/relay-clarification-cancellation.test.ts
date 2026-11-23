import { RelayClient } from "../packages/client/src/index.ts"
import {
  Device,
  SocketEvent,
  Timestamp,
  makeDeviceId,
  now,
  taskDeadlineError,
  version,
} from "../packages/protocol/src/index.ts"
import { Effect, Schema } from "effect"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { WebSocket } from "ws"

it("settles cancellation and deadlines for clarification answers queued offline", async () => {
  const reservation = createServer()
  reservation.listen(0, "127.0.0.1")
  await once(reservation, "listening")
  const address = reservation.address()
  if (address === null || typeof address === "string") throw new Error("Expected test port")
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  const directory = await mkdtemp(join(tmpdir(), "cohall-clarification-cancellation-"))
  const token = "clarification-cancellation-owner-token".padEnd(64, "0")
  const baseUrl = `http://127.0.0.1:${address.port}`
  const relay = spawn(process.execPath, ["apps/relay/src/main.ts"], {
    env: {
      ...process.env,
      COHALL_RELAY_HOST: "127.0.0.1",
      COHALL_RELAY_PORT: String(address.port),
      COHALL_DATA_DIR: directory,
      COHALL_TOKEN: token,
    },
    stdio: "ignore",
  })
  const exited = once(relay, "exit")
  const client = RelayClient.make({ baseUrl, token })
  const device = Device.make({
    id: makeDeviceId(),
    name: "clarification-worker",
    hostname: "localhost",
    platform: "linux",
    architecture: "x64",
    status: "online",
    providers: ["codex"],
    capabilities: [
      { id: "task-clarification", label: "Clarification" },
      { id: "task-deadlines", label: "Deadlines" },
    ],
    workspaces: [],
    version,
    lastSeenAt: now(),
  })
  let worker: WebSocket | undefined
  try {
    await vi.waitFor(async () => expect((await fetch(`${baseUrl}/api/health`)).ok).toBe(true), {
      timeout: 10_000,
    })
    const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws/device`)
    worker = socket
    const send = (event: SocketEvent) => socket.send(JSON.stringify(event))
    socket.on("message", (data) => {
      const event = Schema.decodeUnknownSync(SocketEvent)(JSON.parse(data.toString()))
      if (event._tag === "Connected") send({ _tag: "DeviceHello", device })
      if (event._tag === "TaskAssigned" && event.task.runId !== undefined) {
        send({ _tag: "TaskAccepted", taskId: event.task.id, runId: event.task.runId })
        send({
          _tag: "TaskInputRequested",
          taskId: event.task.id,
          runId: event.task.runId,
          question: "Which branch?",
        })
      }
    })
    await once(socket, "open")
    send({ _tag: "Authenticate", token })
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.devices()))[0]?.status).toBe("online")
    })
    const expiresAt = Timestamp.make(new Date(Date.now() + 5_000).toISOString())
    const tasks = await Effect.runPromise(
      Effect.all([
        client.createTask({ targetDeviceId: device.id, prompt: "Cancel after answering" }),
        client.createTask({
          targetDeviceId: device.id,
          prompt: "Expire after answering",
          expiresAt,
        }),
      ]),
    )
    for (const task of tasks) {
      await vi.waitFor(async () => {
        expect((await Effect.runPromise(client.getTask(task.id))).status).toBe("needs_input")
      })
    }
    socket.close()
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.devices()))[0]?.status).toBe("offline")
    })
    for (const task of tasks) {
      const paused = await Effect.runPromise(client.getTask(task.id))
      const question = paused.clarifications?.at(-1)
      if (question === undefined) throw new Error("Expected a clarification question")
      const answered = await Effect.runPromise(
        client.answerTaskInput(task.id, { requestId: question.id, answer: "main" }),
      )
      expect(answered.status).toBe("queued")
    }

    const cancelled = await Effect.runPromise(client.cancelTask(tasks[0].id))
    await vi.waitFor(
      async () => {
        expect((await Effect.runPromise(client.getTask(tasks[1].id))).status).not.toBe("queued")
      },
      { timeout: 10_000 },
    )
    const expired = await Effect.runPromise(client.getTask(tasks[1].id))
    expect([cancelled, expired]).toMatchObject([
      { status: "cancelled", completedAt: expect.any(String) },
      { status: "failed", error: taskDeadlineError, completedAt: expect.any(String) },
    ])
    expect((await Effect.runPromise(client.inbox())).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: cancelled.id, status: "cancelled" }),
        expect.objectContaining({ id: expired.id, status: "failed" }),
      ]),
    )
  } finally {
    worker?.terminate()
    if (relay.exitCode === null) relay.kill("SIGKILL")
    await exited
    await rm(directory, { recursive: true, force: true })
  }
})
