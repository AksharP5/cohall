import { Device, DeviceId, now, version } from "@cohall/protocol"
import { Effect, ManagedRuntime } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { Database } from "./database.ts"
import { RelayStore } from "./store.ts"

it("bounds outstanding work, serial assignment, and thread context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-store-"))
  const runtime = ManagedRuntime.make(RelayStore.layer(join(directory, "relay.db")))
  const run = <A, E>(effect: Effect.Effect<A, E, RelayStore.Service>): Promise<A> =>
    runtime.runPromise(effect)
  try {
    const deviceId = DeviceId.make("11111111-1111-4111-8111-111111111111")
    await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        yield* store.upsertDevice(
          Device.make({
            id: deviceId,
            name: "bounded-device",
            hostname: "localhost",
            platform: "linux",
            architecture: "x64",
            status: "online",
            providers: ["codex"],
            capabilities: [],
            workspaces: [],
            version,
            lastSeenAt: now(),
          }),
        )
      }),
    )

    const first = await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        return yield* store.createDelegation(
          { prompt: "x".repeat(131_072), context: "y".repeat(131_072) },
          deviceId,
        )
      }),
    )
    const tasks = [first]
    for (let index = 1; index < 100; index += 1) {
      tasks.push(
        await run(
          Effect.gen(function* () {
            const store = yield* RelayStore.Service
            return yield* store.createDelegation(
              { threadId: first.threadId, prompt: `queued-${index}` },
              deviceId,
            )
          }),
        ),
      )
    }
    await expect(
      run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          return yield* store.createDelegation({ prompt: "overflow" }, deviceId)
        }),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("outstanding task limit") })

    const assigned = await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        return yield* store.assignTask(first.id)
      }),
    )
    const second = tasks[1]
    if (second === undefined) {
      throw new Error("Expected a second task")
    }
    const stillQueued = await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        return yield* store.assignTask(second.id)
      }),
    )
    expect(assigned.status).toBe("assigned")
    expect(stillQueued.status).toBe("queued")

    const trace = await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        yield* store.rollbackAssignment(first.id)
        yield* store.assignTask(first.id)
        yield* store.acceptTask(first.id, deviceId)
        yield* store.finishTask(first.id, deviceId, "done")
        return yield* store.traceTask(first.id)
      }),
    )
    expect(trace.events.map((event) => event.kind)).toEqual([
      "queued",
      "assigned",
      "requeued",
      "assigned",
      "running",
      "completed",
    ])
    expect(trace.targetDevice.id).toBe(deviceId)
    expect(trace.truncated).toBe(false)

    const context = await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        return yield* store.threadContext(first.threadId)
      }),
    )
    expect(context.truncated).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify(context)).byteLength).toBeLessThan(1_100_000)
  } finally {
    await runtime.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it("forgets only offline devices and revokes their registration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-store-forget-"))
  const databasePath = join(directory, "relay.db")
  const legacy = new Database(databasePath)
  legacy.exec(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, hostname TEXT NOT NULL,
      platform TEXT NOT NULL, architecture TEXT NOT NULL, status TEXT NOT NULL,
      providers_json TEXT NOT NULL, capabilities_json TEXT NOT NULL,
      workspaces_json TEXT NOT NULL, version TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      connected_at TEXT
    )
  `)
  legacy.close()
  const runtime = ManagedRuntime.make(RelayStore.layer(databasePath))
  const run = <A, E>(effect: Effect.Effect<A, E, RelayStore.Service>): Promise<A> =>
    runtime.runPromise(effect)
  try {
    const paired = await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        const pairing = yield* store.createPairing({ label: "stale device", roles: ["device"] })
        return yield* store.exchangePairing(pairing.token)
      }),
    )
    const credential = paired.credentials[0]
    const deviceId = credential?.session.deviceId
    if (credential === undefined || deviceId === undefined) {
      throw new Error("Expected a device credential")
    }
    const device = Device.make({
      id: deviceId,
      name: "stale-device",
      hostname: "localhost",
      platform: "linux",
      architecture: "x64",
      status: "offline",
      providers: ["codex"],
      capabilities: [],
      workspaces: [],
      version,
      lastSeenAt: now(),
    })

    await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        yield* store.upsertDevice(device)
        yield* store.forgetDevice(deviceId)
      }),
    )
    expect(
      await run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          return yield* store.listDevices()
        }),
      ),
    ).toEqual([])
    expect(
      await run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          return yield* store.authenticateSession(credential.token, "device")
        }),
      ),
    ).toBeUndefined()

    await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        yield* store.upsertDevice(Device.make({ ...device, status: "online" }))
      }),
    )
    await expect(
      run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          return yield* store.forgetDevice(deviceId)
        }),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("must be offline") })
  } finally {
    await runtime.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it("prunes the oldest terminal task history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-store-history-"))
  const runtime = ManagedRuntime.make(RelayStore.layer(join(directory, "relay.db"), 2))
  const run = <A, E>(effect: Effect.Effect<A, E, RelayStore.Service>): Promise<A> =>
    runtime.runPromise(effect)
  try {
    const deviceId = DeviceId.make("33333333-3333-4333-8333-333333333333")
    await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        yield* store.upsertDevice(
          Device.make({
            id: deviceId,
            name: "history-device",
            hostname: "localhost",
            platform: "linux",
            architecture: "x64",
            status: "online",
            providers: ["codex"],
            capabilities: [],
            workspaces: [],
            version,
            lastSeenAt: now(),
          }),
        )
      }),
    )
    const tasks = []
    for (let index = 0; index < 3; index += 1) {
      tasks.push(
        await run(
          Effect.gen(function* () {
            const store = yield* RelayStore.Service
            const task = yield* store.createDelegation({ prompt: `task-${index}` }, deviceId)
            yield* store.assignTask(task.id)
            yield* store.acceptTask(task.id, deviceId)
            return yield* store.finishTask(task.id, deviceId, `result-${index}`)
          }),
        ),
      )
    }
    const oldest = tasks[0]
    const newest = tasks[2]
    if (oldest === undefined || newest === undefined) {
      throw new Error("Expected three completed tasks")
    }
    await expect(
      run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          return yield* store.getTask(oldest.id)
        }),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("Unknown task") })
    await expect(
      run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          return yield* store.getTask(newest.id)
        }),
      ),
    ).resolves.toMatchObject({ result: "result-2" })
  } finally {
    await runtime.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
