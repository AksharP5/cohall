import { Device, DeviceId, makeDeviceId, now, version } from "@cohall/protocol"
import { Effect, ManagedRuntime } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { Database } from "./database.ts"
import { resolveDelegation } from "./main.ts"
import { RelayStore } from "./store.ts"

it("assigns queued followups with the session completed before a restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-store-session-"))
  const databasePath = join(directory, "relay.db")
  const original = ManagedRuntime.make(RelayStore.layer(databasePath))
  let restored:
    | ManagedRuntime.ManagedRuntime<RelayStore.Service, RelayStore.PersistenceError>
    | undefined
  try {
    const store = await original.runPromise(RelayStore.Service)
    const device = Device.make({
      id: makeDeviceId(),
      name: "session-device",
      hostname: "localhost",
      platform: "linux",
      architecture: "x64",
      status: "online",
      providers: ["codex"],
      capabilities: [],
      workspaces: [],
      version,
      lastSeenAt: now(),
    })
    await Effect.runPromise(store.upsertDevice(device))
    const first = await Effect.runPromise(
      store.createDelegation({ prompt: "Start" }, device.id, "owner"),
    )
    await Effect.runPromise(store.assignTask(first.id))
    await Effect.runPromise(store.acceptTask(first.id, device.id))
    const followup = await Effect.runPromise(
      store.createDelegation({ prompt: "Continue", threadId: first.threadId }, device.id, "owner"),
    )
    expect((await Effect.runPromise(store.assignTask(followup.id))).status).toBe("queued")
    await Effect.runPromise(store.finishTask(first.id, device.id, "Answer", "completed-session"))
    await original.dispose()

    restored = ManagedRuntime.make(RelayStore.layer(databasePath))
    const recovered = await restored.runPromise(RelayStore.Service)
    await Effect.runPromise(recovered.recover())
    expect(await Effect.runPromise(recovered.assignTask(followup.id))).toMatchObject({
      status: "assigned",
      providerSessionId: "completed-session",
    })
  } finally {
    await original.dispose()
    await restored?.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it("attributes full-worker clients after registration and prefers a peer for delegation", async () => {
  const runtime = ManagedRuntime.make(RelayStore.layer(":memory:"))
  try {
    const store = await runtime.runPromise(RelayStore.Service)
    const pairing = await Effect.runPromise(
      store.createPairing({ label: "Worker", roles: ["client", "device"] }),
    )
    const paired = await Effect.runPromise(store.exchangePairing(pairing.token))
    const client = paired.credentials.find(({ session }) => session.role === "client")
    const worker = paired.credentials.find(({ session }) => session.role === "device")
    if (client === undefined || worker?.session.deviceId === undefined) {
      throw new Error("Expected full-worker credentials")
    }
    expect(client.session.deviceId).toBe(worker.session.deviceId)
    const principal = await Effect.runPromise(store.authenticateSession(client.token, "client"))
    if (principal === undefined) throw new Error("Expected authenticated client")
    expect(principal.deviceId).toBe(worker.session.deviceId)
    const peer = Device.make({
      id: makeDeviceId(),
      name: "b-peer",
      hostname: "peer.local",
      platform: "linux",
      architecture: "x64",
      status: "online",
      providers: ["codex"],
      capabilities: [],
      workspaces: [],
      version,
      lastSeenAt: now(),
    })
    await Effect.runPromise(store.upsertDevice(peer))
    const early = await Effect.runPromise(
      store.createDelegation({ prompt: "Before registration" }, peer.id, principal),
    )
    expect(early.sourceDeviceId).toBeUndefined()
    await Effect.runPromise(
      store.upsertDevice({ ...peer, id: worker.session.deviceId, name: "a-source" }),
    )
    const { targetDeviceId: target } = await runtime.runPromise(
      resolveDelegation({ prompt: "Work on a peer" }, principal.deviceId),
    )
    expect(target).toBe(peer.id)
    const task = await Effect.runPromise(
      store.createDelegation({ prompt: "After registration" }, target, principal),
    )
    expect(task.sourceDeviceId).toBe(worker.session.deviceId)
    expect((await Effect.runPromise(store.threadContext(task.threadId))).messages[0]).toMatchObject(
      {
        authorName: "Remote agent",
        deviceId: worker.session.deviceId,
      },
    )

    const clientOnlyPairing = await Effect.runPromise(
      store.createPairing({ label: "Client", roles: ["client"] }),
    )
    const clientOnly = await Effect.runPromise(store.exchangePairing(clientOnlyPairing.token))
    expect(clientOnly.credentials[0]?.session.deviceId).toBeUndefined()
  } finally {
    await runtime.dispose()
  }
})

it("keeps completion inboxes private to each client and retains acknowledgements", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-inbox-"))
  const databasePath = join(directory, "relay.db")
  const original = ManagedRuntime.make(RelayStore.layer(databasePath))
  let restored: typeof original | undefined
  try {
    const store = await original.runPromise(RelayStore.Service)
    const device = Device.make({
      id: makeDeviceId(),
      name: "inbox-target",
      hostname: "localhost",
      platform: "linux",
      architecture: "x64",
      status: "online",
      providers: ["codex"],
      capabilities: [],
      workspaces: [],
      version,
      lastSeenAt: now(),
    })
    await Effect.runPromise(store.upsertDevice(device))
    const pair = async (label: string) => {
      const invite = await Effect.runPromise(store.createPairing({ label, roles: ["client"] }))
      const joined = await Effect.runPromise(store.exchangePairing(invite.token))
      const session = joined.credentials[0]?.session
      if (session === undefined) throw new Error("Expected client session")
      return session
    }
    const firstClient = await pair("First")
    const secondClient = await pair("Second")
    const completed = await Effect.runPromise(
      store.createDelegation({ prompt: "Find the cause" }, device.id, firstClient),
    )
    const pending = await Effect.runPromise(
      store.createDelegation({ prompt: "Still running" }, device.id, firstClient),
    )
    const failed = await Effect.runPromise(
      store.createDelegation({ prompt: "Other client's work" }, device.id, secondClient),
    )
    const ownerTask = await Effect.runPromise(
      store.createDelegation({ prompt: "Owner's work" }, device.id, "owner"),
    )
    await Effect.runPromise(store.finishTask(completed.id, device.id, "😀".repeat(600)))
    await Effect.runPromise(store.failTask(failed.id, device.id, "Provider failed"))
    await Effect.runPromise(store.requestCancellation(ownerTask.id))

    expect(await Effect.runPromise(store.inboxFor(firstClient))).toEqual({
      items: [
        expect.objectContaining({
          id: completed.id,
          status: "completed",
          promptPreview: "Find the cause",
          resultPreview: "😀".repeat(512),
        }),
      ],
      hasMore: false,
    })
    expect((await Effect.runPromise(store.inboxFor(secondClient))).items[0]?.id).toBe(failed.id)
    expect((await Effect.runPromise(store.inboxFor("owner"))).items[0]?.id).toBe(ownerTask.id)
    expect(pending.status).toBe("queued")
    await expect(
      Effect.runPromise(store.acknowledgeCompletion(completed.id, secondClient)),
    ).rejects.toMatchObject({ message: `Unknown inbox task ${completed.id}` })
    await Effect.runPromise(store.acknowledgeCompletion(completed.id, firstClient))
    await Effect.runPromise(store.acknowledgeCompletion(completed.id, firstClient))
    await original.dispose()

    restored = ManagedRuntime.make(RelayStore.layer(databasePath))
    const recovered = await restored.runPromise(RelayStore.Service)
    expect(await Effect.runPromise(recovered.inboxFor(firstClient))).toEqual({
      items: [],
      hasMore: false,
    })
    expect((await Effect.runPromise(recovered.inboxFor(secondClient))).items[0]?.id).toBe(failed.id)
  } finally {
    await original.dispose()
    await restored?.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it("reveals additional completions as older inbox entries are acknowledged", async () => {
  const runtime = ManagedRuntime.make(RelayStore.layer(":memory:"))
  try {
    const store = await runtime.runPromise(RelayStore.Service)
    const device = Device.make({
      id: makeDeviceId(),
      name: "inbox-target",
      hostname: "localhost",
      platform: "linux",
      architecture: "x64",
      status: "online",
      providers: ["codex"],
      capabilities: [],
      workspaces: [],
      version,
      lastSeenAt: now(),
    })
    await Effect.runPromise(store.upsertDevice(device))
    for (let index = 0; index < 21; index += 1) {
      const task = await Effect.runPromise(
        store.createDelegation({ prompt: `Task ${index}` }, device.id, "owner"),
      )
      await Effect.runPromise(store.finishTask(task.id, device.id, "Done"))
    }
    const firstPage = await Effect.runPromise(store.inboxFor("owner"))
    expect(firstPage.items).toHaveLength(20)
    expect(firstPage.hasMore).toBe(true)
    const first = firstPage.items[0]
    if (first === undefined) throw new Error("Expected an inbox task")
    await Effect.runPromise(store.acknowledgeCompletion(first.id, "owner"))
    const nextPage = await Effect.runPromise(store.inboxFor("owner"))
    expect(nextPage.items).toHaveLength(20)
    expect(nextPage.hasMore).toBe(false)
    expect(nextPage.items).not.toContainEqual(expect.objectContaining({ id: first.id }))
  } finally {
    await runtime.dispose()
  }
})

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
          "owner",
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
              "owner",
            )
          }),
        ),
      )
    }
    await expect(
      run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          return yield* store.createDelegation({ prompt: "overflow" }, deviceId, "owner")
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
        const pairing = yield* store.createPairing({
          label: "stale device",
          roles: ["client", "device"],
        })
        return yield* store.exchangePairing(pairing.token)
      }),
    )
    const credential = paired.credentials.find(({ session }) => session.role === "device")
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
    for (const pairedCredential of paired.credentials) {
      expect(
        await run(
          Effect.gen(function* () {
            const store = yield* RelayStore.Service
            return yield* store.authenticateSession(
              pairedCredential.token,
              pairedCredential.session.role,
            )
          }),
        ),
      ).toBeUndefined()
    }

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
            const task = yield* store.createDelegation(
              { prompt: `task-${index}` },
              deviceId,
              "owner",
            )
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
          "owner",
        )
        yield* store.assignTask(completed.id)
        yield* store.acceptTask(completed.id, serverId)
        yield* store.finishTask(completed.id, serverId, "done")
        return yield* store.createDelegation(
          { prompt: "queued", provider: "claude-code" },
          laptopId,
          "owner",
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

it("rejects all-device operations before every daemon supports them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-store-legacy-operation-"))
  const runtime = ManagedRuntime.make(RelayStore.layer(join(directory, "relay.db")))
  const run = <A, E>(effect: Effect.Effect<A, E, RelayStore.Service>): Promise<A> =>
    runtime.runPromise(effect)
  try {
    await run(
      Effect.gen(function* () {
        const store = yield* RelayStore.Service
        yield* store.upsertDevice(
          Device.make({
            id: DeviceId.make("66666666-6666-4666-8666-666666666666"),
            name: "legacy",
            hostname: "legacy.local",
            platform: "linux",
            architecture: "x64",
            status: "online",
            providers: ["codex"],
            capabilities: [],
            workspaces: [],
            version: "0.4.10",
            lastSeenAt: now(),
          }),
        )
      }),
    )

    await expect(
      run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          return yield* store.createUpgradeOperations({ target: "latest", restart: true })
        }),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("Upgrade individually first") })
    await expect(
      run(
        Effect.gen(function* () {
          const store = yield* RelayStore.Service
          return yield* store.listOperations()
        }),
      ),
    ).resolves.toEqual([])
  } finally {
    await runtime.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
