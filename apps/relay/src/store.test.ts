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

    const abandoned = await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        yield* store.upsertDevice(device)
        const operations = yield* store.createUpgradeOperations({ target: "latest", restart: true })
        yield* store.forgetDevice(deviceId)
        return operations[0]
      }),
    )
    if (abandoned === undefined) {
      throw new Error("Expected an abandoned operation")
    }
    await expect(
      run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          return yield* store.listOperations()
        }),
      ),
    ).resolves.toContainEqual(
      expect.objectContaining({
        id: abandoned.id,
        status: "failed",
        error: "Target device was forgotten by the relay owner",
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

it("summarizes retained work and runs typed upgrades across registered devices", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-store-operations-"))
  const runtime = ManagedRuntime.make(RelayStore.layer(join(directory, "relay.db")))
  const run = <A, E>(effect: Effect.Effect<A, E, RelayStore.Service>): Promise<A> =>
    runtime.runPromise(effect)
  try {
    const serverId = DeviceId.make("44444444-4444-4444-8444-444444444444")
    const laptopId = DeviceId.make("55555555-5555-4555-8555-555555555555")
    await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        for (const [id, name] of [
          [serverId, "server"],
          [laptopId, "laptop"],
        ] as const) {
          yield* store.upsertDevice(
            Device.make({
              id,
              name,
              hostname: `${name}.local`,
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
        }
      }),
    )

    const laptopTask = await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        const completed = yield* store.createDelegation(
          { prompt: "completed", provider: "codex" },
          serverId,
        )
        yield* store.assignTask(completed.id)
        yield* store.acceptTask(completed.id, serverId)
        yield* store.finishTask(completed.id, serverId, "done")
        return yield* store.createDelegation(
          { prompt: "queued", provider: "claude-code" },
          laptopId,
        )
      }),
    )

    await expect(
      run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          return yield* store.usage()
        }),
      ),
    ).resolves.toMatchObject({
      retainedTasks: 2,
      byStatus: { completed: 1, queued: 1 },
      byProvider: [
        { provider: "codex", tasks: 1 },
        { provider: "claude-code", tasks: 1 },
      ],
    })

    await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        yield* store.assignTask(laptopTask.id)
      }),
    )

    const operations = await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        return yield* store.createUpgradeOperations({ target: "1.2.3", restart: true })
      }),
    )
    expect(operations).toHaveLength(2)
    const serverOperation = operations.find((operation) => operation.targetDeviceId === serverId)
    const laptopOperation = operations.find((operation) => operation.targetDeviceId === laptopId)
    if (serverOperation === undefined || laptopOperation === undefined) {
      throw new Error("Expected one upgrade operation per device")
    }

    await expect(
      run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          return yield* store.assignOperation(laptopOperation.id)
        }),
      ),
    ).resolves.toMatchObject({ status: "queued" })

    await expect(
      run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          yield* store.assignOperation(serverOperation.id)
          yield* store.acceptOperation(serverOperation.id, serverId)
          yield* store.requeueOperationsFor(serverId)
          const completed = yield* store.finishOperation(
            serverOperation.id,
            serverId,
            '{"upgraded":true}',
          )
          const replayed = yield* store.assignOperation(serverOperation.id)
          return { completed, replayed }
        }),
      ),
    ).resolves.toMatchObject({
      completed: { status: "completed", result: '{"upgraded":true}' },
      replayed: { status: "completed", result: '{"upgraded":true}' },
    })

    await expect(
      run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          return yield* store.createUpgradeOperations({ target: "latest", restart: true })
        }),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("already has") })

    await expect(
      run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          return yield* store.abandonOperation(laptopOperation.id)
        }),
      ),
    ).resolves.toMatchObject({ status: "failed", error: "Abandoned by the relay owner" })

    await expect(
      run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          return yield* store.createUpgradeOperations({ target: "latest", restart: true })
        }),
      ),
    ).resolves.toHaveLength(2)
  } finally {
    await runtime.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
