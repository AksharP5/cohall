import { RelayClient, exchangePairing } from "../packages/client/src/index.ts"
import {
  AnswerTaskInput,
  BotId,
  Device,
  RequestTaskInput,
  SocketEvent,
  TaskProgressInput,
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

it("expires undispatched offline work and delivers interrupted-task cancellation on reconnect", async () => {
  const reservation = createServer()
  reservation.listen(0, "127.0.0.1")
  await once(reservation, "listening")
  const address = reservation.address()
  if (address === null || typeof address === "string") throw new Error("Expected test port")
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  const directory = await mkdtemp(join(tmpdir(), "cohall-reconnect-"))
  const token = "reconnect-test-owner-token".padEnd(64, "0")
  const baseUrl = `http://127.0.0.1:${address.port}`
  const relay = spawn(process.execPath, ["bin/cohall.js", "relay"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      COHALL_RELAY_HOST: "127.0.0.1",
      COHALL_RELAY_PORT: String(address.port),
      COHALL_DATA_DIR: directory,
      COHALL_TOKEN: token,
    },
    stdio: "ignore",
  })
  const sockets: Array<WebSocket> = []
  const botId = BotId.make("reconnecting-bot")
  let device = Device.make({
    id: makeDeviceId(),
    name: "reconnecting-device",
    hostname: "localhost",
    platform: "linux",
    architecture: "x64",
    providers: ["codex", "grok-bot"],
    bots: [{ id: botId, name: "Research" }],
    capabilities: [
      { id: "task-clarification", label: "Clarification" },
      { id: "task-deadlines", label: "Deadlines" },
    ],
    workspaces: [],
    version,
    status: "online",
    lastSeenAt: now(),
  })
  const client = RelayClient.make({ baseUrl, token })
  const connect = async (credential: string, replay?: SocketEvent) => {
    const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws/device`)
    sockets.push(socket)
    const events: Array<SocketEvent> = []
    const send = (event: SocketEvent) => socket.send(JSON.stringify(event))
    socket.on("message", (message) => {
      const event = Schema.decodeUnknownSync(SocketEvent)(JSON.parse(message.toString()))
      events.push(event)
      if (event._tag === "Connected") {
        send({ _tag: "DeviceHello", device })
        if (replay !== undefined) send(replay)
      }
    })
    await once(socket, "open")
    send({ _tag: "Authenticate", token: credential })
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.devices()))[0]?.status).toBe("online")
    })
    return { socket, events, send }
  }
  try {
    await vi.waitFor(
      async () => {
        expect((await fetch(`${baseUrl}/api/health`)).ok).toBe(true)
      },
      { timeout: 10_000 },
    )
    const pairing = await Effect.runPromise(
      client.createPairing({ label: "Worker", roles: ["device"] }),
    )
    const joined = await Effect.runPromise(exchangePairing(baseUrl, { token: pairing.token }))
    const credential = joined.credentials[0]
    if (credential === undefined) throw new Error("Expected worker credential")
    const deviceId = credential.session.deviceId
    if (deviceId === undefined) throw new Error("Expected paired device ID")
    device = Device.make({ ...device, id: deviceId })
    const original = await connect(credential.token)
    const bot = await Effect.runPromise(
      client.createTask({
        targetDeviceId: device.id,
        botId,
        prompt: "Delegate local work",
      }),
    )
    original.send({ _tag: "TaskAccepted", taskId: bot.id })
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.getTask(bot.id))).status).toBe("running")
    })
    const coding = await Effect.runPromise(
      client.createTask({ targetDeviceId: device.id, provider: "codex", prompt: "Keep working" }),
    )
    if (coding.runId === undefined) throw new Error("Expected coding turn")
    original.send({ _tag: "TaskAccepted", taskId: coding.id, runId: coding.runId })
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.getTask(coding.id))).status).toBe("running")
    })
    const [upgrade] = await Effect.runPromise(
      client.createUpgradeOperations({ target: "latest", restart: true }),
    )
    if (upgrade === undefined) throw new Error("Expected queued upgrade")
    expect(upgrade.status).toBe("queued")
    const closed = once(original.socket, "close")
    original.socket.close()
    await closed
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.devices()))[0]?.status).toBe("offline")
    })
    const offline = await Effect.runPromise(
      client.createTask({
        targetDeviceId: device.id,
        provider: "codex",
        prompt: "Expire without dispatch",
        expiresAt: Timestamp.make(new Date(Date.now() + 2_000).toISOString()),
      }),
    )
    expect(offline.status).toBe("queued")
    expect(offline.runId).toBeUndefined()
    await vi.waitFor(
      async () => {
        expect(await Effect.runPromise(client.getTask(offline.id))).toMatchObject({
          status: "failed",
          error: taskDeadlineError,
        })
      },
      { timeout: 10_000 },
    )
    const unsent = await Effect.runPromise(
      client.createTask({ targetDeviceId: device.id, provider: "codex", prompt: "Cancel unsent" }),
    )
    expect((await Effect.runPromise(client.cancelTask(unsent.id))).status).toBe("cancelled")
    expect((await Effect.runPromise(client.cancelTask(coding.id))).status).toBe("cancelling")
    expect(
      (await Effect.runPromise(client.inbox())).items.some((item) => item.id === coding.id),
    ).toBe(false)

    const resumed = await connect(credential.token)
    await vi.waitFor(() => {
      expect(resumed.events).toContainEqual({
        _tag: "CancelTask",
        taskId: coding.id,
        runId: coding.runId,
      })
    })
    resumed.send({ _tag: "TaskCancelled", taskId: coding.id, runId: coding.runId })
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.getTask(coding.id))).status).toBe("cancelled")
    })
    await vi.waitFor(() => {
      expect(
        resumed.events.some((event) => event._tag === "TaskAssigned" && event.task.id === bot.id),
      ).toBe(true)
    })
    expect(resumed.events.some((event) => event._tag === "OperationAssigned")).toBe(false)
    const child = await Effect.runPromise(
      client.createTask({
        targetDeviceId: device.id,
        provider: "codex",
        parentTaskId: bot.id,
        threadId: bot.threadId,
        prompt: "Local child work",
      }),
    )
    expect(child.status).toBe("assigned")
    const followup = await Effect.runPromise(
      client.createTask({
        targetDeviceId: device.id,
        botId,
        prompt: "Follow up after upgrade",
      }),
    )
    expect(followup.status).toBe("queued")
    resumed.send({ _tag: "TaskFinished", taskId: child.id, result: "Child done" })
    resumed.send({ _tag: "TaskFinished", taskId: bot.id, result: "Parent done" })
    await vi.waitFor(() => {
      expect(
        resumed.events.some(
          (event) => event._tag === "OperationAssigned" && event.operation.id === upgrade.id,
        ),
      ).toBe(true)
    })
    expect((await Effect.runPromise(client.getTask(followup.id))).status).toBe("queued")
    resumed.send({ _tag: "OperationFinished", operationId: upgrade.id, result: "Upgraded" })
    await vi.waitFor(() => {
      expect(
        resumed.events.some(
          (event) => event._tag === "TaskAssigned" && event.task.id === followup.id,
        ),
      ).toBe(true)
    })
    const disconnect = async (socket: WebSocket) => {
      const closed = once(socket, "close")
      socket.close()
      await closed
      await vi.waitFor(async () => {
        expect((await Effect.runPromise(client.devices()))[0]?.status).toBe("offline")
      })
    }
    await disconnect(resumed.socket)
    const interrupted = await connect(credential.token)
    const questionTask = await Effect.runPromise(
      client.createTask({
        targetDeviceId: device.id,
        provider: "codex",
        prompt: "Ask before continuing",
      }),
    )
    const runId = questionTask.runId
    if (runId === undefined) throw new Error("Expected worker turn")
    interrupted.send({ _tag: "TaskAccepted", taskId: questionTask.id, runId })
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.getTask(questionTask.id))).status).toBe("running")
    })
    const workerClient = RelayClient.make({ baseUrl, token: credential.token })
    const question = await Effect.runPromise(
      workerClient.requestTaskInput(
        questionTask.id,
        Schema.decodeUnknownSync(RequestTaskInput)({ runId, question: "Which branch?" }),
      ),
    )
    await disconnect(interrupted.socket)
    await expect(
      Effect.runPromise(
        client.answerTaskInput(
          questionTask.id,
          Schema.decodeUnknownSync(AnswerTaskInput)({ requestId: question.id, answer: "main" }),
        ),
      ),
    ).rejects.toMatchObject({ status: 409 })
    expect(await Effect.runPromise(client.getTask(questionTask.id))).toMatchObject({
      status: "queued",
      runId,
      clarifications: [question],
    })
    expect((await Effect.runPromise(client.cancelTask(questionTask.id))).status).toBe("cancelling")
    const reconnected = await connect(credential.token)
    await vi.waitFor(() => {
      expect(reconnected.events).toContainEqual({
        _tag: "CancelTask",
        taskId: questionTask.id,
        runId,
      })
    })
    reconnected.send({
      _tag: "TaskFinished",
      taskId: questionTask.id,
      runId,
      result: "Retained partial result",
    })
    await vi.waitFor(() => {
      expect(reconnected.events).toContainEqual({
        _tag: "TaskSettled",
        taskId: questionTask.id,
        runId,
      })
    })
    expect((await Effect.runPromise(client.getTask(questionTask.id))).status).toBe("cancelling")
    reconnected.send({ _tag: "TaskCancelled", taskId: questionTask.id, runId })
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.getTask(questionTask.id))).status).toBe("cancelled")
    })
    reconnected.send({ _tag: "TaskFinished", taskId: followup.id, result: "Follow-up done" })
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.getTask(followup.id))).status).toBe("completed")
    })
    const offlineQuestion = await Effect.runPromise(
      client.createTask({ targetDeviceId: device.id, botId, prompt: "Ask while disconnected" }),
    )
    if (offlineQuestion.runId === undefined) throw new Error("Expected Bot turn")
    reconnected.send({
      _tag: "TaskAccepted",
      taskId: offlineQuestion.id,
      runId: offlineQuestion.runId,
    })
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.getTask(offlineQuestion.id))).status).toBe("running")
    })
    await disconnect(reconnected.socket)
    const replayed = await connect(
      credential.token,
      Schema.decodeUnknownSync(SocketEvent)({
        _tag: "TaskInputRequested",
        taskId: offlineQuestion.id,
        runId: offlineQuestion.runId,
        question: "Which branch?",
      }),
    )
    await vi.waitFor(() => {
      expect(replayed.events).toContainEqual({
        _tag: "TaskSettled",
        taskId: offlineQuestion.id,
        runId: offlineQuestion.runId,
      })
    })
    expect(await Effect.runPromise(client.getTask(offlineQuestion.id))).toMatchObject({
      status: "needs_input",
      clarifications: [{ question: "Which branch?" }],
    })
    expect((await Effect.runPromise(client.inbox())).items).toContainEqual(
      expect.objectContaining({
        id: offlineQuestion.id,
        inputRequest: expect.objectContaining({ question: "Which branch?" }),
      }),
    )
  } finally {
    for (const socket of sockets) socket.terminate()
    const exited = once(relay, "exit", { signal: AbortSignal.timeout(2_000) })
    relay.kill("SIGTERM")
    await exited.catch(() => relay.kill("SIGKILL"))
    await rm(directory, { recursive: true, force: true })
  }
})

it("replays the active coding turn before an older answered task on reconnect", async () => {
  const reservation = createServer()
  reservation.listen(0, "127.0.0.1")
  await once(reservation, "listening")
  const address = reservation.address()
  if (address === null || typeof address === "string") throw new Error("Expected test port")
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  const directory = await mkdtemp(join(tmpdir(), "cohall-replay-order-"))
  const token = "replay-order-test-owner-token".padEnd(64, "0")
  const baseUrl = `http://127.0.0.1:${address.port}`
  const relay = spawn(process.execPath, ["bin/cohall.js", "relay"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      COHALL_RELAY_HOST: "127.0.0.1",
      COHALL_RELAY_PORT: String(address.port),
      COHALL_DATA_DIR: directory,
      COHALL_TOKEN: token,
    },
    stdio: "ignore",
  })
  const sockets: Array<WebSocket> = []
  const device = Device.make({
    id: makeDeviceId(),
    name: "replay-order-device",
    hostname: "localhost",
    platform: "linux",
    architecture: "x64",
    providers: ["codex"],
    capabilities: [{ id: "task-clarification", label: "Clarification" }],
    workspaces: [],
    version,
    status: "online",
    lastSeenAt: now(),
  })
  const client = RelayClient.make({ baseUrl, token })
  const connect = async () => {
    const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws/device`)
    sockets.push(socket)
    const events: Array<SocketEvent> = []
    const send = (event: SocketEvent) => socket.send(JSON.stringify(event))
    socket.on("message", (data) => {
      const event = Schema.decodeUnknownSync(SocketEvent)(JSON.parse(data.toString()))
      events.push(event)
      if (event._tag === "Connected") send({ _tag: "DeviceHello", device })
      if (event._tag === "TaskAssigned") {
        send({
          _tag: "TaskAccepted",
          taskId: event.task.id,
          ...(event.task.runId === undefined ? {} : { runId: event.task.runId }),
        })
      }
    })
    await once(socket, "open")
    send({ _tag: "Authenticate", token })
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.devices()))[0]?.status).toBe("online")
    })
    return { socket, events, send }
  }
  try {
    await vi.waitFor(async () => expect((await fetch(`${baseUrl}/api/health`)).ok).toBe(true), {
      timeout: 10_000,
    })
    const original = await connect()
    const older = await Effect.runPromise(
      client.createTask({ targetDeviceId: device.id, provider: "codex", prompt: "Ask first" }),
    )
    if (older.runId === undefined) throw new Error("Expected questioning turn")
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.getTask(older.id))).status).toBe("running")
    })
    const question = await Effect.runPromise(
      client.requestTaskInput(
        older.id,
        Schema.decodeUnknownSync(RequestTaskInput)({
          runId: older.runId,
          question: "Which branch?",
        }),
      ),
    )
    original.send({ _tag: "TaskFinished", taskId: older.id, runId: older.runId, result: "Asked" })
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.getTask(older.id))).status).toBe("needs_input")
    })
    const newer = await Effect.runPromise(
      client.createTask({ targetDeviceId: device.id, provider: "codex", prompt: "Keep working" }),
    )
    if (newer.runId === undefined) throw new Error("Expected active turn")
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.getTask(newer.id))).status).toBe("running")
    })
    const answered = await Effect.runPromise(
      client.answerTaskInput(
        older.id,
        Schema.decodeUnknownSync(AnswerTaskInput)({ requestId: question.id, answer: "main" }),
      ),
    )
    expect(answered.status).toBe("queued")
    const closed = once(original.socket, "close")
    original.socket.close()
    await closed
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.devices()))[0]?.status).toBe("offline")
    })
    const reconnected = await connect()
    await vi.waitFor(async () => {
      expect(await Effect.runPromise(client.getTask(newer.id))).toMatchObject({
        status: "running",
        runId: newer.runId,
      })
    })
    expect(
      reconnected.events
        .filter((event) => event._tag === "TaskAssigned")
        .map((event) => event.task.id),
    ).toEqual([newer.id])
    expect(await Effect.runPromise(client.getTask(older.id))).toMatchObject({
      status: "queued",
      runId: answered.runId,
    })
    await Effect.runPromise(
      client.reportTaskProgress(
        newer.id,
        Schema.decodeUnknownSync(TaskProgressInput)({ note: "Still working" }),
      ),
    )
    expect(
      await Effect.runPromise(
        client.requestTaskInput(
          newer.id,
          Schema.decodeUnknownSync(RequestTaskInput)({
            runId: newer.runId,
            question: "Which tests?",
          }),
        ),
      ),
    ).toMatchObject({ question: "Which tests?" })
  } finally {
    for (const socket of sockets) socket.terminate()
    const exited = once(relay, "exit", { signal: AbortSignal.timeout(2_000) })
    relay.kill("SIGTERM")
    await exited.catch(() => relay.kill("SIGKILL"))
    await rm(directory, { recursive: true, force: true })
  }
})
