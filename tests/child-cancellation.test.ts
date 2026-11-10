import { RelayClient } from "../packages/client/src/index.ts"
import { Device, SocketEvent, makeDeviceId, now } from "../packages/protocol/src/index.ts"
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

it("stops delegated child work when its parent task is cancelled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-child-cancel-"))
  const runtime = ManagedRuntime.make(RelayStore.layer(join(directory, "cohall.db")))
  const reservation = createServer()
  let relay: ReturnType<typeof spawn> | undefined
  let socket: WebSocket | undefined
  try {
    const store = await runtime.runPromise(RelayStore.Service)
    const worker = (name: string) =>
      Device.make({
        id: makeDeviceId(),
        name,
        hostname: "localhost",
        platform: "linux",
        architecture: "x64",
        status: "online",
        providers: ["codex"],
        capabilities: [],
        workspaces: [],
        version: "0.12.12",
        lastSeenAt: now(),
      })
    const parentWorker = worker("parent-worker")
    const childWorker = worker("child-worker")
    await Effect.runPromise(store.upsertDevice(parentWorker))
    await Effect.runPromise(store.upsertDevice(childWorker))
    const parent = await Effect.runPromise(
      store.createDelegation({ prompt: "Parent" }, parentWorker.id, "owner"),
    )
    const assigned = await Effect.runPromise(store.assignTask(parent.id))
    await Effect.runPromise(store.acceptTask(parent.id, parentWorker.id, assigned.runId))
    const child = await Effect.runPromise(
      store.createDelegation(
        { prompt: "Child", parentTaskId: parent.id, threadId: parent.threadId },
        childWorker.id,
        "owner",
      ),
    )
    const grandchild = await Effect.runPromise(
      store.createDelegation(
        { prompt: "Grandchild", parentTaskId: child.id, threadId: parent.threadId },
        childWorker.id,
        "owner",
      ),
    )
    await runtime.dispose()

    reservation.listen(0, "127.0.0.1")
    await once(reservation, "listening")
    const address = reservation.address()
    if (address === null || typeof address === "string") throw new Error("Expected test port")
    await new Promise<void>((resolve) => reservation.close(() => resolve()))
    const token = "child-cancellation-owner-token".padEnd(64, "0")
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
    const connection = new WebSocket(`${baseUrl.replace("http", "ws")}/ws/device`)
    socket = connection
    const send = (event: SocketEvent) => connection.send(JSON.stringify(event))
    connection.on("message", (data) => {
      const event = Schema.decodeUnknownSync(SocketEvent)(JSON.parse(data.toString()))
      events.push(event)
      if (event._tag === "Connected") send({ _tag: "DeviceHello", device: childWorker })
      if (event._tag === "TaskAssigned")
        send({ _tag: "TaskAccepted", taskId: event.task.id, runId: event.task.runId })
    })
    await once(connection, "open")
    send({ _tag: "Authenticate", token })
    await vi.waitFor(async () => {
      expect((await Effect.runPromise(client.getTask(child.id))).status).toBe("running")
    })

    await Effect.runPromise(client.cancelTask(parent.id))

    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ _tag: "CancelTask", taskId: child.id }),
      ),
    )
    expect((await Effect.runPromise(client.getTask(child.id))).status).toBe("cancelling")
    expect((await Effect.runPromise(client.getTask(grandchild.id))).status).toBe("cancelled")
    await expect(
      Effect.runPromise(client.createTask({ prompt: "Late child", parentTaskId: parent.id })),
    ).rejects.toMatchObject({ status: 409, message: "The parent task has been cancelled" })
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
