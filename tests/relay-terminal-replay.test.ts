import { RelayClient } from "../packages/client/src/index.ts"
import {
  Device,
  SocketEvent,
  TaskRunId,
  makeDeviceId,
  now,
} from "../packages/protocol/src/index.ts"
import { RelayStore } from "../apps/relay/src/store.ts"
import { Effect, ManagedRuntime, Schema } from "effect"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { WebSocket } from "ws"

it("settles replayed terminal replies after history pruning while retaining device and run guards", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-terminal-replay-"))
  const runtime = ManagedRuntime.make(RelayStore.layer(join(directory, "cohall.db"), 1))
  const reservation = createServer()
  let relay: ReturnType<typeof spawn> | undefined
  let socket: WebSocket | undefined
  try {
    const store = await runtime.runPromise(RelayStore.Service)
    const device = Device.make({
      id: makeDeviceId(),
      name: "replay-worker",
      hostname: "localhost",
      platform: "linux",
      architecture: "x64",
      status: "online",
      providers: ["codex"],
      capabilities: [],
      workspaces: [],
      version: "0.9.0",
      lastSeenAt: now(),
    })
    await Effect.runPromise(store.upsertDevice(device))
    const completeTask = async () => {
      const task = await Effect.runPromise(
        store.createDelegation({ prompt: "Complete before pruning" }, device.id, "owner"),
      )
      const assigned = await Effect.runPromise(store.assignTask(task.id))
      await Effect.runPromise(store.acceptTask(task.id, device.id, assigned.runId))
      return Effect.runPromise(
        store.finishTask(task.id, device.id, "Done", undefined, undefined, assigned.runId),
      )
    }
    const prunedTask = await completeTask()
    await completeTask()
    const completeOperation = async () => {
      const [operation] = await Effect.runPromise(
        store.createUpgradeOperations({ target: "latest", restart: false }),
      )
      if (operation === undefined) throw new Error("Expected an upgrade operation")
      return Effect.runPromise(store.finishOperation(operation.id, device.id, "Updated"))
    }
    const prunedOperation = await completeOperation()
    await completeOperation()
    await expect(Effect.runPromise(store.getTask(prunedTask.id))).rejects.toMatchObject({
      message: `Unknown task ${prunedTask.id}`,
    })
    expect(await Effect.runPromise(store.listOperations())).not.toContainEqual(
      expect.objectContaining({ id: prunedOperation.id }),
    )

    const retainedTask = await Effect.runPromise(
      store.createDelegation({ prompt: "Keep running" }, device.id, "owner"),
    )
    const otherDevice = Device.make({ ...device, id: makeDeviceId(), name: "other-worker" })
    await Effect.runPromise(store.upsertDevice(otherDevice))
    const otherTask = await Effect.runPromise(
      store.createDelegation({ prompt: "Another worker's task" }, otherDevice.id, "owner"),
    )
    await runtime.dispose()

    reservation.listen(0, "127.0.0.1")
    await once(reservation, "listening")
    const address = reservation.address()
    if (address === null || typeof address === "string") throw new Error("Expected test port")
    await new Promise<void>((resolve) => reservation.close(() => resolve()))
    const token = "terminal-replay-owned-test-token".padEnd(64, "0")
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
    const events: Array<SocketEvent> = []
    const worker = new WebSocket(`${baseUrl.replace("http", "ws")}/ws/device`)
    socket = worker
    const send = (event: SocketEvent) => worker.send(JSON.stringify(event))
    worker.on("message", (data) => {
      const event = Schema.decodeUnknownSync(SocketEvent)(JSON.parse(data.toString()))
      events.push(event)
      if (event._tag === "Connected") send({ _tag: "DeviceHello", device })
    })
    await once(worker, "open")
    send({ _tag: "Authenticate", token })
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.getTask(retainedTask.id))).status).toBe("assigned")
    })

    // These replies stayed pending on the worker when their original settlement was lost.
    send({
      _tag: "TaskFinished",
      taskId: prunedTask.id,
      runId: prunedTask.runId,
      result: "Done",
    })
    send({ _tag: "OperationFinished", operationId: prunedOperation.id, result: "Updated" })
    await vi.waitFor(() => {
      expect(events).toContainEqual({
        _tag: "TaskSettled",
        taskId: prunedTask.id,
        runId: prunedTask.runId,
      })
      expect(events).toContainEqual({
        _tag: "OperationSettled",
        operationId: prunedOperation.id,
      })
    })
    expect(events.filter((event) => event._tag === "Error")).toEqual([])
    await expect(Effect.runPromise(client.getTask(prunedTask.id))).rejects.toMatchObject({
      status: 404,
    })

    send({ _tag: "TaskFinished", taskId: otherTask.id, result: "Wrong worker" })
    send({ _tag: "TaskAccepted", taskId: prunedTask.id, runId: prunedTask.runId })
    await vi.waitFor(() => {
      expect(events.filter((event) => event._tag === "Error")).toHaveLength(2)
    })
    expect(events).not.toContainEqual(
      expect.objectContaining({
        _tag: "TaskSettled",
        taskId: otherTask.id,
      }),
    )
    expect((await Effect.runPromise(client.getTask(otherTask.id))).status).toBe("queued")

    const staleRunId = TaskRunId.make(crypto.randomUUID())
    send({ _tag: "TaskFinished", taskId: retainedTask.id, runId: staleRunId, result: "Stale" })
    await vi.waitFor(() => {
      expect(events).toContainEqual({
        _tag: "TaskSettled",
        taskId: retainedTask.id,
        runId: staleRunId,
      })
    })
    const unchanged = await Effect.runPromise(client.getTask(retainedTask.id))
    expect(unchanged.status).toBe("assigned")
    expect(unchanged.result).toBeUndefined()
  } finally {
    socket?.terminate()
    if (relay !== undefined && relay.exitCode === null) {
      const exited = once(relay, "exit")
      relay.kill("SIGKILL")
      await exited
    }
    reservation.close()
    await runtime.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
