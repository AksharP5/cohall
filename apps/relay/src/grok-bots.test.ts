import { BotId, Device, makeDeviceId, now, version } from "@cohall/protocol"
import { Effect, ManagedRuntime } from "effect"
import { expect, it } from "vitest"
import { Database } from "./database.ts"
import { chooseDevice } from "./main.ts"
import { RelayStore } from "./store.ts"

const reacher = { id: BotId.make("bot-reacher"), name: "Reacher" }
const scout = { id: BotId.make("bot-scout"), name: "X Scout" }
const grokComputer = () =>
  Device.make({
    id: makeDeviceId(),
    name: "grok-computer",
    hostname: "grok.local",
    platform: "linux",
    architecture: "x64",
    status: "online",
    providers: ["codex", "claude-code", "grok-bot"],
    bots: [reacher, scout],
    capabilities: [],
    workspaces: [],
    version,
    lastSeenAt: now(),
  })

const withStore = async (test: (store: RelayStore.Interface) => Promise<void>) => {
  const runtime = ManagedRuntime.make(RelayStore.layer(":memory:"))
  try {
    await test(await runtime.runPromise(RelayStore.Service))
  } finally {
    await runtime.dispose()
  }
}

it("routes only advertised bots and refreshes a roster without reconnecting the device", async () => {
  await withStore(async (store) => {
    const device = grokComputer()
    await Effect.runPromise(store.upsertDevice(device))
    await expect(
      Effect.runPromise(
        chooseDevice({
          prompt: "Hello",
          botId: reacher.id,
          targetDeviceId: device.id,
        }).pipe(Effect.provideService(RelayStore.Service, store)),
      ),
    ).resolves.toBe(device.id)
    await expect(
      Effect.runPromise(
        chooseDevice({
          prompt: "Hello",
          botId: BotId.make("missing-bot"),
          targetDeviceId: device.id,
        }).pipe(Effect.provideService(RelayStore.Service, store)),
      ),
    ).rejects.toMatchObject({ status: 404 })

    await Effect.runPromise(store.markDeviceOffline(device.id))
    await expect(
      Effect.runPromise(
        chooseDevice({
          prompt: "Queue this",
          botId: scout.id,
        }).pipe(Effect.provideService(RelayStore.Service, store)),
      ),
    ).resolves.toBe(device.id)
    const updated = await Effect.runPromise(
      store.heartbeat(device.id, "busy", [{ ...scout, name: "Renamed Scout" }]),
    )
    expect(updated.bots).toEqual([{ ...scout, name: "Renamed Scout" }])
    expect(updated.status).toBe("busy")
    expect(updated.connectedAt).toBe(device.connectedAt)
    expect((await Effect.runPromise(store.heartbeat(device.id, "online"))).bots).toEqual(
      updated.bots,
    )
    expect((await Effect.runPromise(store.heartbeat(device.id, "online", []))).bots).toEqual([])
    await expect(
      Effect.runPromise(
        chooseDevice({
          prompt: "Hello again",
          botId: scout.id,
        }).pipe(Effect.provideService(RelayStore.Service, store)),
      ),
    ).rejects.toMatchObject({ status: 409 })
  })
})

it("runs bot and local CLI tasks in separate slots while upgrades wait for every slot", async () => {
  await withStore(async (store) => {
    const device = grokComputer()
    await Effect.runPromise(store.upsertDevice(device))
    const botTask = await Effect.runPromise(
      store.createDelegation({ prompt: "Delegate work", botId: reacher.id }, device.id),
    )
    const botFollowup = await Effect.runPromise(
      store.createDelegation(
        { prompt: "Follow up", botId: reacher.id, threadId: botTask.threadId },
        device.id,
      ),
    )
    const scoutTask = await Effect.runPromise(
      store.createDelegation(
        { prompt: "Research", botId: scout.id, threadId: botTask.threadId },
        device.id,
      ),
    )
    expect((await Effect.runPromise(store.assignTask(botTask.id))).status).toBe("assigned")
    await Effect.runPromise(store.acceptTask(botTask.id, device.id))
    expect((await Effect.runPromise(store.assignTask(botFollowup.id))).status).toBe("queued")
    expect((await Effect.runPromise(store.assignTask(scoutTask.id))).status).toBe("assigned")

    const [operation] = await Effect.runPromise(
      store.createUpgradeOperations({ target: "latest", restart: true }),
    )
    if (operation === undefined) throw new Error("Expected device upgrade")
    expect((await Effect.runPromise(store.assignOperation(operation.id))).status).toBe("queued")
    const child = await Effect.runPromise(
      store.createDelegation(
        {
          prompt: "Build the project",
          threadId: botTask.threadId,
          parentTaskId: botTask.id,
          provider: "codex",
        },
        device.id,
        device.id,
      ),
    )
    expect((await Effect.runPromise(store.assignTask(child.id))).status).toBe("assigned")
    expect(child.parentTaskId).toBe(botTask.id)
    const otherCli = await Effect.runPromise(
      store.createDelegation({ prompt: "More CLI work", provider: "claude-code" }, device.id),
    )
    expect((await Effect.runPromise(store.assignTask(otherCli.id))).status).toBe("queued")
    await Effect.runPromise(
      store.finishTask(botTask.id, device.id, "Bot answer", "reacher-session"),
    )
    await Effect.runPromise(
      store.finishTask(scoutTask.id, device.id, "Scout answer", "scout-session"),
    )
    expect((await Effect.runPromise(store.assignOperation(operation.id))).status).toBe("queued")
    await Effect.runPromise(store.finishTask(child.id, device.id, "Built", "codex-session"))
    expect((await Effect.runPromise(store.assignOperation(operation.id))).status).toBe("assigned")
    expect((await Effect.runPromise(store.assignTask(botFollowup.id))).status).toBe("queued")
    expect((await Effect.runPromise(store.assignTask(otherCli.id))).status).toBe("queued")
    await Effect.runPromise(store.finishOperation(operation.id, device.id, "Upgraded"))
    expect((await Effect.runPromise(store.assignTask(botFollowup.id))).status).toBe("assigned")
    expect((await Effect.runPromise(store.assignTask(otherCli.id))).status).toBe("assigned")
    expect((await Effect.runPromise(store.getTask(botTask.id))).providerSessionId).toBeUndefined()
    expect(
      await Effect.runPromise(store.sessionFor(botTask.threadId, device.id, "grok-bot")),
    ).toBeUndefined()
    expect(await Effect.runPromise(store.sessionFor(botTask.threadId, device.id, "codex"))).toBe(
      "codex-session",
    )
    expect((await Effect.runPromise(store.traceTask(scoutTask.id))).botId).toBe(scout.id)
  })
})

it("cancels queued bot work without claiming to stop a running Grok Bot", async () => {
  await withStore(async (store) => {
    const device = grokComputer()
    await Effect.runPromise(store.upsertDevice(device))
    const queued = await Effect.runPromise(
      store.createDelegation({ prompt: "Queued", botId: reacher.id }, device.id),
    )
    expect((await Effect.runPromise(store.requestCancellation(queued.id))).status).toBe("cancelled")
    const active = await Effect.runPromise(
      store.createDelegation({ prompt: "Active", botId: reacher.id }, device.id),
    )
    await Effect.runPromise(store.assignTask(active.id))
    await expect(Effect.runPromise(store.requestCancellation(active.id))).rejects.toMatchObject({
      message: "Stop this bot in Grok Bot; its gateway cannot cancel an individual Cohall request",
    })
    expect((await Effect.runPromise(store.getTask(active.id))).status).toBe("assigned")
    await Effect.runPromise(store.acceptTask(active.id, device.id))
    await expect(Effect.runPromise(store.requestCancellation(active.id))).rejects.toBeDefined()
    await Effect.runPromise(store.requeueTasksFor(device.id))
    expect((await Effect.runPromise(store.getTask(active.id))).status).toBe("queued")
    await expect(Effect.runPromise(store.requestCancellation(active.id))).rejects.toMatchObject({
      message: "Stop this bot in Grok Bot; its gateway cannot cancel an individual Cohall request",
    })
    await Effect.runPromise(store.assignTask(active.id))
    await Effect.runPromise(store.recover())
    await expect(Effect.runPromise(store.requestCancellation(active.id))).rejects.toBeDefined()
    await Effect.runPromise(store.finishTask(active.id, device.id, "Answer"))
    expect((await Effect.runPromise(store.requestCancellation(active.id))).status).toBe("completed")
  })
})

it("adds bot discovery and task columns without changing CLI sessions or history", async () => {
  const database = new Database(":memory:")
  const original = ManagedRuntime.make(RelayStore.layerFromDatabase(database))
  const device = grokComputer()
  let migrated:
    | ManagedRuntime.ManagedRuntime<RelayStore.Service, RelayStore.PersistenceError>
    | undefined
  try {
    const store = await original.runPromise(RelayStore.Service)
    await Effect.runPromise(store.upsertDevice({ ...device, providers: ["codex"] }))
    const task = await Effect.runPromise(
      store.createDelegation({ prompt: "Legacy work" }, device.id),
    )
    await Effect.runPromise(store.assignTask(task.id))
    await Effect.runPromise(store.finishTask(task.id, device.id, "Legacy result", "legacy-session"))
    await original.dispose()
    database.exec(`
      ALTER TABLE devices DROP COLUMN bots_json;
      ALTER TABLE tasks DROP COLUMN bot_id;
    `)
    migrated = ManagedRuntime.make(RelayStore.layerFromDatabase(database))
    const restored = await migrated.runPromise(RelayStore.Service)
    expect((await Effect.runPromise(restored.listDevices()))[0]?.bots).toBeUndefined()
    expect((await Effect.runPromise(restored.getTask(task.id))).result).toBe("Legacy result")
    expect(await Effect.runPromise(restored.sessionFor(task.threadId, device.id, "codex"))).toBe(
      "legacy-session",
    )
    await Effect.runPromise(restored.upsertDevice(device))
    const botTask = await Effect.runPromise(
      restored.createDelegation(
        { prompt: "Bot work", botId: reacher.id, threadId: task.threadId },
        device.id,
      ),
    )
    await Effect.runPromise(restored.assignTask(botTask.id))
    await Effect.runPromise(restored.finishTask(botTask.id, device.id, "Bot result", "bot-session"))
    expect((await Effect.runPromise(restored.getTask(botTask.id))).botId).toBe(reacher.id)
    expect(
      (await Effect.runPromise(restored.getTask(botTask.id))).providerSessionId,
    ).toBeUndefined()
    expect(await Effect.runPromise(restored.sessionFor(task.threadId, device.id, "codex"))).toBe(
      "legacy-session",
    )
  } finally {
    await original.dispose()
    await migrated?.dispose()
    database.close()
  }
})
