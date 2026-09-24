import {
  BotId,
  Device,
  makeDeviceId,
  makeTaskId,
  makeThreadId,
  now,
  version,
} from "@cohall/protocol"
import { Effect, ManagedRuntime } from "effect"
import { expect, it } from "vitest"
import { Database } from "./database.ts"
import { resolveDelegation } from "./main.ts"
import { RelayStore } from "./store.ts"

const botId = BotId.make("research-bot")
const otherBotId = BotId.make("engineering-bot")
const device = (name: string) =>
  Device.make({
    id: makeDeviceId(),
    name,
    hostname: `${name}.local`,
    platform: "linux",
    architecture: "x64",
    status: "online",
    providers: ["codex", "grok-bot"],
    bots: [
      { id: botId, name: "Research" },
      { id: otherBotId, name: "Engineering" },
    ],
    capabilities: [],
    workspaces: [],
    version,
    lastSeenAt: now(),
  })

it("routes child tasks away from their parent and inherits only that parent's thread", async () => {
  const runtime = ManagedRuntime.make(RelayStore.layer(":memory:"))
  try {
    const store = await runtime.runPromise(RelayStore.Service)
    const source = device("a-source")
    const peer = device("b-peer")
    await Effect.runPromise(store.upsertDevice(source))
    await Effect.runPromise(store.upsertDevice(peer))
    const parent = await Effect.runPromise(store.createDelegation({ prompt: "Parent" }, source.id))
    await Effect.runPromise(store.assignTask(parent.id))
    await Effect.runPromise(store.acceptTask(parent.id, source.id))
    const input = { prompt: "Child", parentTaskId: parent.id }
    expect(await runtime.runPromise(resolveDelegation(input))).toEqual({
      input: { ...input, threadId: parent.threadId },
      targetDeviceId: peer.id,
    })
    await expect(
      runtime.runPromise(resolveDelegation({ ...input, targetDeviceId: source.id })),
    ).rejects.toMatchObject({ status: 409 })
    await expect(
      runtime.runPromise(resolveDelegation({ ...input, threadId: makeThreadId() })),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      runtime.runPromise(resolveDelegation({ ...input, parentTaskId: makeTaskId() })),
    ).rejects.toMatchObject({ status: 404 })
    await Effect.runPromise(store.finishTask(parent.id, source.id, "Done"))
    expect(
      await runtime.runPromise(resolveDelegation({ ...input, targetDeviceId: source.id })),
    ).toMatchObject({ targetDeviceId: source.id })
  } finally {
    await runtime.dispose()
  }
})

it("bounds legacy ancestor walks when history has been pruned or contains a cycle", async () => {
  const database = new Database(":memory:")
  const runtime = ManagedRuntime.make(RelayStore.layerFromDatabase(database))
  try {
    const store = await runtime.runPromise(RelayStore.Service)
    const source = device("source")
    await Effect.runPromise(store.upsertDevice(source))
    const parent = await Effect.runPromise(
      store.createDelegation({ prompt: "Retained parent", parentTaskId: makeTaskId() }, source.id),
    )
    await Effect.runPromise(store.finishTask(parent.id, source.id, "Done"))
    const input = { prompt: "Follow up", parentTaskId: parent.id }
    expect(await runtime.runPromise(resolveDelegation(input))).toMatchObject({
      targetDeviceId: source.id,
    })
    database.query("UPDATE tasks SET parent_task_id = id WHERE id = ?").run(parent.id)
    expect(await runtime.runPromise(resolveDelegation(input))).toMatchObject({
      targetDeviceId: source.id,
    })
  } finally {
    await runtime.dispose()
    database.close()
  }
})

it("checks retained ancestors while allowing separate bot and CLI slots on one device", async () => {
  const runtime = ManagedRuntime.make(RelayStore.layer(":memory:"))
  try {
    const store = await runtime.runPromise(RelayStore.Service)
    const source = device("source")
    await Effect.runPromise(store.upsertDevice(source))
    const parent = await Effect.runPromise(
      store.createDelegation({ prompt: "Bot parent", botId }, source.id),
    )
    await Effect.runPromise(store.assignTask(parent.id))
    await Effect.runPromise(store.acceptTask(parent.id, source.id))
    const childInput = { prompt: "CLI child", parentTaskId: parent.id, targetDeviceId: source.id }
    const childRoute = await runtime.runPromise(resolveDelegation(childInput))
    const child = await Effect.runPromise(
      store.createDelegation(childRoute.input, childRoute.targetDeviceId),
    )
    await Effect.runPromise(store.assignTask(child.id))
    await Effect.runPromise(store.acceptTask(child.id, source.id))
    await expect(
      runtime.runPromise(resolveDelegation({ prompt: "Grandchild", parentTaskId: child.id })),
    ).rejects.toMatchObject({ status: 409 })
    await expect(
      runtime.runPromise(
        resolveDelegation({ prompt: "Blocked bot grandchild", botId, parentTaskId: child.id }),
      ),
    ).rejects.toMatchObject({ status: 409 })
    expect(
      await runtime.runPromise(
        resolveDelegation({
          prompt: "Other bot grandchild",
          botId: otherBotId,
          parentTaskId: child.id,
        }),
      ),
    ).toMatchObject({ targetDeviceId: source.id })
    await Effect.runPromise(store.requeueTasksFor(source.id))
    await expect(
      runtime.runPromise(
        resolveDelegation({ prompt: "Requeued parent's child", parentTaskId: child.id }),
      ),
    ).rejects.toMatchObject({ status: 409 })
  } finally {
    await runtime.dispose()
  }
})
