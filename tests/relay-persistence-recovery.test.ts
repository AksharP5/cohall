import { RelayClient } from "../packages/client/src/index.ts"
import { Device, SocketEvent, makeDeviceId, now, version } from "../packages/protocol/src/index.ts"
import { Database } from "../apps/relay/src/database.ts"
import { Effect, Schema } from "effect"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { WebSocket } from "ws"

it("reconnects to replay terminal replies after temporary persistence failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-persistence-recovery-"))
  const reservation = createServer()
  const sockets: Array<WebSocket> = []
  let relay: ReturnType<typeof spawn> | undefined
  let database: Database | undefined
  try {
    reservation.listen(0, "127.0.0.1")
    await once(reservation, "listening")
    const address = reservation.address()
    if (address === null || typeof address === "string") throw new Error("Expected test port")
    await new Promise<void>((resolve) => reservation.close(() => resolve()))
    const token = "persistence-recovery-owned-test-token".padEnd(64, "0")
    const baseUrl = `http://127.0.0.1:${address.port}`
    relay = spawn(process.execPath, ["apps/relay/src/main.ts"], {
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
    await vi.waitFor(async () => expect((await fetch(`${baseUrl}/api/health`)).ok).toBe(true), {
      timeout: 10_000,
    })
    const client = RelayClient.make({ baseUrl, token })
    const device = Device.make({
      id: makeDeviceId(),
      name: "persistence-worker",
      hostname: "localhost",
      platform: "linux",
      architecture: "x64",
      status: "online",
      providers: ["codex"],
      capabilities: [{ id: "task-clarification", label: "Clarification" }],
      workspaces: [],
      version,
      lastSeenAt: now(),
    })
    const events: Array<SocketEvent> = []
    const connectWorker = async () => {
      const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws/device`)
      sockets.push(socket)
      const connected = Promise.withResolvers<void>()
      socket.on("message", (data) => {
        const event = Schema.decodeUnknownSync(SocketEvent)(JSON.parse(data.toString()))
        events.push(event)
        if (event._tag === "Connected") {
          socket.send(JSON.stringify({ _tag: "DeviceHello", device }))
          connected.resolve()
        }
      })
      await once(socket, "open")
      socket.send(JSON.stringify({ _tag: "Authenticate", token }))
      await connected.promise
      await vi.waitFor(async () => {
        expect((await Effect.runPromise(client.devices()))[0]?.status).toBe("online")
      })
      return socket
    }
    let worker = await connectWorker()
    const task = await Effect.runPromise(
      client.createTask({ targetDeviceId: device.id, prompt: "Finish despite a storage outage" }),
    )
    worker.send(JSON.stringify({ _tag: "TaskAccepted", taskId: task.id, runId: task.runId }))
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.getTask(task.id))).status).toBe("running")
    })
    const followup = await Effect.runPromise(
      client.createTask({
        targetDeviceId: device.id,
        prompt: "Continue in the saved session",
        threadId: task.threadId,
      }),
    )
    expect(followup.status).toBe("queued")
    database = new Database(join(directory, "cohall.db"))
    database.exec("PRAGMA busy_timeout = 5000")
    database.exec(`CREATE TRIGGER fail_task_result BEFORE INSERT ON messages
      WHEN NEW.role = 'agent' BEGIN
        SELECT RAISE(FAIL, 'injected temporary persistence failure');
      END`)
    const completion = {
      _tag: "TaskFinished",
      taskId: task.id,
      runId: task.runId,
      result: "Saved after reconnecting",
      providerSessionId: "recovered-session",
    } as const
    worker.send(JSON.stringify(completion))
    await vi.waitFor(() => {
      expect(events).toContainEqual({
        _tag: "Error",
        code: "event_failed",
        message: "injected temporary persistence failure",
      })
    })
    database.exec("DROP TRIGGER fail_task_result")
    expect(events).not.toContainEqual({ _tag: "TaskSettled", taskId: task.id, runId: task.runId })
    expect((await Effect.runPromise(client.inbox())).items).toEqual([])
    expect(database.query("SELECT 1 FROM messages WHERE role = 'agent'").get()).toBeNull()
    expect(
      database.query("SELECT 1 FROM task_trace_events WHERE kind = 'completed'").get(),
    ).toBeNull()
    await vi.waitFor(() => expect(worker.readyState).toBe(WebSocket.CLOSED), { timeout: 1_500 })
    worker = await connectWorker()
    database.exec(`CREATE TRIGGER fail_followup_dispatch BEFORE UPDATE ON tasks
      WHEN NEW.id <> '${task.id}' AND NEW.status = 'assigned' BEGIN
        SELECT RAISE(FAIL, 'injected temporary persistence failure');
      END`)
    worker.send(JSON.stringify(completion))
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.getTask(task.id))).status).toBe("completed")
      expect(events.filter((event) => event._tag === "Error")).toHaveLength(2)
    })
    database.exec("DROP TRIGGER fail_followup_dispatch")
    expect(events).toContainEqual({ _tag: "TaskSettled", taskId: task.id, runId: task.runId })
    expect((await Effect.runPromise(client.getTask(followup.id))).status).toBe("queued")
    await vi.waitFor(() => expect(worker.readyState).toBe(WebSocket.CLOSED), { timeout: 1_500 })
    worker = await connectWorker()
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.getTask(followup.id))).status).toBe("assigned")
    })
    expect((await Effect.runPromise(client.getTask(followup.id))).providerSessionId).toBe(
      "recovered-session",
    )
    expect((await Effect.runPromise(client.inbox())).items).toEqual([
      expect.objectContaining({ id: task.id, resultPreview: completion.result }),
    ])
    expect(database.query("SELECT content FROM messages WHERE role = 'agent'").all()).toEqual([
      { content: completion.result },
    ])
    expect(
      database.query("SELECT kind FROM task_trace_events WHERE kind = 'completed'").all(),
    ).toEqual([{ kind: "completed" }])
    worker.send(JSON.stringify(completion))
    worker.send(JSON.stringify({ _tag: "TaskFinished", taskId: followup.id, result: "Done" }))
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.getTask(followup.id))).status).toBe("completed")
    })
    const [operation] = await Effect.runPromise(
      client.createUpgradeOperations({ target: "latest", restart: false }),
    )
    if (operation === undefined) throw new Error("Expected an upgrade operation")
    database.exec(`CREATE TRIGGER fail_operation_result BEFORE UPDATE ON device_operations
      WHEN NEW.status = 'completed' BEGIN
        SELECT RAISE(FAIL, 'injected temporary persistence failure');
      END`)
    const errors = events.filter((event) => event._tag === "Error").length
    const operationReply = {
      _tag: "OperationFinished",
      operationId: operation.id,
      result: "Upgrade completed",
    } as const
    worker.send(JSON.stringify(operationReply))
    await vi.waitFor(() => {
      expect(events.filter((event) => event._tag === "Error")).toHaveLength(errors + 1)
    })
    database.exec("DROP TRIGGER fail_operation_result")
    expect(events).not.toContainEqual({ _tag: "OperationSettled", operationId: operation.id })
    await vi.waitFor(() => expect(worker.readyState).toBe(WebSocket.CLOSED), { timeout: 1_500 })
    worker = await connectWorker()
    worker.send(JSON.stringify(operationReply))
    await vi.waitFor(async () => {
      expect(await Effect.runPromise(client.operations())).toContainEqual(
        expect.objectContaining({
          id: operation.id,
          status: "completed",
          result: operationReply.result,
        }),
      )
      expect(events).toContainEqual({ _tag: "OperationSettled", operationId: operation.id })
    })

    const questionTask = await Effect.runPromise(
      client.createTask({ targetDeviceId: device.id, prompt: "Ask before continuing" }),
    )
    worker.send(
      JSON.stringify({ _tag: "TaskAccepted", taskId: questionTask.id, runId: questionTask.runId }),
    )
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.getTask(questionTask.id))).status).toBe("running")
    })
    database.exec(`CREATE TRIGGER fail_question BEFORE INSERT ON task_trace_events
      WHEN NEW.kind = 'input_requested' BEGIN
        SELECT RAISE(FAIL, 'injected temporary persistence failure');
      END`)
    const questionReply = {
      _tag: "TaskInputRequested",
      taskId: questionTask.id,
      runId: questionTask.runId,
      question: "Which branch?",
    } as const
    worker.send(JSON.stringify(questionReply))
    await vi.waitFor(() => {
      expect(events.filter((event) => event._tag === "Error")).toHaveLength(errors + 2)
    })
    database.exec("DROP TRIGGER fail_question")
    expect(
      (await Effect.runPromise(client.getTask(questionTask.id))).clarifications,
    ).toBeUndefined()
    await vi.waitFor(() => expect(worker.readyState).toBe(WebSocket.CLOSED), { timeout: 1_500 })
    worker = await connectWorker()
    worker.send(JSON.stringify(questionReply))
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.getTask(questionTask.id))).status).toBe("needs_input")
      expect((await Effect.runPromise(client.inbox())).items).toContainEqual(
        expect.objectContaining({
          id: questionTask.id,
          inputRequest: expect.objectContaining({ question: questionReply.question }),
        }),
      )
    })
  } finally {
    for (const socket of sockets) socket.terminate()
    if (relay !== undefined && relay.exitCode === null) {
      const exited = once(relay, "exit")
      relay.kill("SIGKILL")
      await exited
    }
    database?.close()
    reservation.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it("replays work after task or operation disconnect cleanup could not persist", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-disconnect-recovery-"))
  const reservation = createServer()
  const sockets: Array<WebSocket> = []
  let relay: ReturnType<typeof spawn> | undefined
  let database: Database | undefined
  try {
    reservation.listen(0, "127.0.0.1")
    await once(reservation, "listening")
    const address = reservation.address()
    if (address === null || typeof address === "string") throw new Error("Expected test port")
    await new Promise<void>((resolve) => reservation.close(() => resolve()))
    const token = "disconnect-recovery-owned-test-token".padEnd(64, "0")
    const baseUrl = `http://127.0.0.1:${address.port}`
    relay = spawn(process.execPath, ["apps/relay/src/main.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        COHALL_RELAY_HOST: "127.0.0.1",
        COHALL_RELAY_PORT: String(address.port),
        COHALL_DATA_DIR: directory,
        COHALL_TOKEN: token,
      },
      stdio: ["ignore", "ignore", "pipe"],
    })
    let errors = ""
    relay.stderr?.on("data", (chunk: Buffer) => {
      errors += chunk.toString()
    })
    await vi.waitFor(async () => expect((await fetch(`${baseUrl}/api/health`)).ok).toBe(true), {
      timeout: 10_000,
    })
    const client = RelayClient.make({ baseUrl, token })
    const device = Device.make({
      id: makeDeviceId(),
      name: "disconnect-worker",
      hostname: "localhost",
      platform: "linux",
      architecture: "arm64",
      status: "online",
      providers: ["codex"],
      capabilities: [],
      workspaces: [],
      version,
      lastSeenAt: now(),
    })
    const connectWorker = async () => {
      const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws/device`)
      sockets.push(socket)
      const events: Array<SocketEvent> = []
      socket.on("message", (data) => {
        const event = Schema.decodeUnknownSync(SocketEvent)(JSON.parse(data.toString()))
        events.push(event)
        if (event._tag === "Connected") socket.send(JSON.stringify({ _tag: "DeviceHello", device }))
      })
      await once(socket, "open")
      socket.send(JSON.stringify({ _tag: "Authenticate", token }))
      await vi.waitFor(async () => {
        expect(events.some((event) => event._tag === "Connected")).toBe(true)
        expect((await Effect.runPromise(client.devices()))[0]?.status).toBe("online")
      })
      return { socket, events }
    }
    let worker = await connectWorker()
    const task = await Effect.runPromise(
      client.createTask({ targetDeviceId: device.id, prompt: "Recover active turn" }),
    )
    worker.socket.send(JSON.stringify({ _tag: "TaskAccepted", taskId: task.id, runId: task.runId }))
    await vi.waitFor(async () =>
      expect((await Effect.runPromise(client.getTask(task.id))).status).toBe("running"),
    )
    const running = await Effect.runPromise(client.getTask(task.id))
    const followup = await Effect.runPromise(
      client.createTask({ targetDeviceId: device.id, prompt: "Wait for recovery" }),
    )
    expect(followup.status).toBe("queued")
    database = new Database(join(directory, "cohall.db"))
    const disconnectDuringFailure = async (db: Database, table: "tasks" | "device_operations") => {
      db.exec(`CREATE TRIGGER fail_disconnect BEFORE UPDATE ON ${table}
        WHEN OLD.status = 'running' AND NEW.status = 'queued' BEGIN
          SELECT RAISE(FAIL, 'injected ${table} disconnect persistence failure');
        END`)
      const closed = once(worker.socket, "close")
      worker.socket.terminate()
      await closed
      await vi.waitFor(() =>
        expect(errors).toContain(`injected ${table} disconnect persistence failure`),
      )
      db.exec("DROP TRIGGER fail_disconnect")
    }
    await disconnectDuringFailure(database, "tasks")
    expect((await Effect.runPromise(client.getTask(task.id))).status).toBe("running")
    worker = await connectWorker()
    await vi.waitFor(() =>
      expect(worker.events).toContainEqual({
        _tag: "TaskAssigned",
        task: expect.objectContaining({
          id: task.id,
          runId: task.runId,
          startedAt: running.startedAt,
        }),
      }),
    )
    expect((await Effect.runPromise(client.getTask(followup.id))).status).toBe("queued")
    worker.socket.send(JSON.stringify({ _tag: "TaskAccepted", taskId: task.id, runId: task.runId }))
    await vi.waitFor(async () =>
      expect(await Effect.runPromise(client.getTask(task.id))).toMatchObject({
        status: "running",
        startedAt: running.startedAt,
      }),
    )
    worker.socket.send(
      JSON.stringify({
        _tag: "TaskFinished",
        taskId: task.id,
        runId: task.runId,
        result: "Recovered",
      }),
    )
    await vi.waitFor(async () =>
      expect((await Effect.runPromise(client.getTask(followup.id))).status).toBe("assigned"),
    )
    const assigned = await Effect.runPromise(client.getTask(followup.id))
    await Effect.runPromise(client.cancelTask(followup.id))
    worker.socket.send(
      JSON.stringify({ _tag: "TaskCancelled", taskId: followup.id, runId: assigned.runId }),
    )
    await vi.waitFor(async () =>
      expect((await Effect.runPromise(client.getTask(followup.id))).status).toBe("cancelled"),
    )

    const [operation] = await Effect.runPromise(
      client.createUpgradeOperations({ target: "latest", restart: false }),
    )
    if (operation === undefined) throw new Error("Expected an upgrade operation")
    worker.socket.send(JSON.stringify({ _tag: "OperationAccepted", operationId: operation.id }))
    await vi.waitFor(async () =>
      expect(await Effect.runPromise(client.operations())).toContainEqual(
        expect.objectContaining({ id: operation.id, status: "running" }),
      ),
    )
    await disconnectDuringFailure(database, "device_operations")
    worker = await connectWorker()
    await vi.waitFor(() =>
      expect(worker.events).toContainEqual({
        _tag: "OperationAssigned",
        operation: expect.objectContaining({ id: operation.id }),
      }),
    )
    const queued = await Effect.runPromise(
      client.createTask({ targetDeviceId: device.id, prompt: "After maintenance" }),
    )
    expect(queued.status).toBe("queued")
    worker.socket.send(
      JSON.stringify({ _tag: "OperationFinished", operationId: operation.id, result: "Recovered" }),
    )
    await vi.waitFor(async () =>
      expect((await Effect.runPromise(client.getTask(queued.id))).status).toBe("assigned"),
    )
    expect(await Effect.runPromise(client.operations())).toContainEqual(
      expect.objectContaining({ id: operation.id, status: "completed" }),
    )
    expect((await Effect.runPromise(client.getTask(task.id))).status).toBe("completed")
    expect((await Effect.runPromise(client.getTask(followup.id))).status).toBe("cancelled")
  } finally {
    for (const socket of sockets) socket.terminate()
    if (relay !== undefined && relay.exitCode === null) {
      const exited = once(relay, "exit")
      relay.kill("SIGKILL")
      await exited
    }
    database?.close()
    reservation.close()
    await rm(directory, { recursive: true, force: true })
  }
})
