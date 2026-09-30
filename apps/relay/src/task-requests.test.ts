import {
  AttachmentName,
  Device,
  TaskRequestId,
  decodeCreateTaskInput,
  makeDeviceId,
  now,
  version,
} from "@cohall/protocol"
import { Effect, ManagedRuntime } from "effect"
import { expect, it } from "vitest"
import { RelayStore } from "./store.ts"
import { Database } from "./database.ts"

const worker = () =>
  Device.make({
    id: makeDeviceId(),
    name: "retry-target",
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

it("atomically reuses a request across concurrent creation and checks all decoded input", async () => {
  const database = new Database(":memory:")
  const runtime = ManagedRuntime.make(RelayStore.layerFromDatabase(database))
  try {
    const store = await runtime.runPromise(RelayStore.Service)
    const target = worker()
    await Effect.runPromise(store.upsertDevice(target))
    const requestId = TaskRequestId.make(crypto.randomUUID())
    const input = await Effect.runPromise(
      decodeCreateTaskInput({
        requestId,
        prompt: "Build",
        context: "Use the current branch",
        attachments: [{ name: "note.txt", data: "YQ==" }],
      }),
    )
    const tasks = await Promise.all(
      Array.from({ length: 10 }, () =>
        Effect.runPromise(store.createDelegation(input, target.id, "owner")),
      ),
    )
    const task = tasks[0]
    if (task === undefined) throw new Error("Missing task")
    expect(new Set(tasks.map(({ id }) => id)).size).toBe(1)
    expect(
      (
        await Effect.runPromise(
          store.findDelegation(
            {
              ...input,
              requestId: TaskRequestId.make(requestId.toUpperCase()),
            },
            "owner",
          ),
        )
      )?.id,
    ).toBe(task.id)
    expect(
      database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM threads").get()?.count,
    ).toBe(1)
    expect((await Effect.runPromise(store.threadContext(task.threadId))).messages).toHaveLength(1)
    // Base64 padding bits do not change the bytes sent to the provider.
    expect(
      (
        await Effect.runPromise(
          store.findDelegation(
            {
              ...input,
              attachments: [{ name: AttachmentName.make("note.txt"), data: "YR==" }],
            },
            "owner",
          ),
        )
      )?.id,
    ).toBe(task.id)
    for (const changed of [
      { ...input, context: "Use a different branch" },
      { ...input, attachments: [{ name: AttachmentName.make("note.txt"), data: "Yg==" }] },
    ]) {
      await expect(
        Effect.runPromise(store.createDelegation(changed, target.id, "owner")),
      ).rejects.toMatchObject({
        status: 409,
        message: "Request ID was already used with different task input",
      })
    }
    await Effect.runPromise(store.requestCancellation(task.id))
    expect((await Effect.runPromise(store.findDelegation(input, "owner")))?.status).toBe(
      "cancelled",
    )
  } finally {
    await runtime.dispose()
    database.close()
  }
})

it("retains used request IDs after the original task history is pruned", async () => {
  const runtime = ManagedRuntime.make(RelayStore.layer(":memory:", 1))
  try {
    const store = await runtime.runPromise(RelayStore.Service)
    const target = worker()
    await Effect.runPromise(store.upsertDevice(target))
    const input = { requestId: TaskRequestId.make(crypto.randomUUID()), prompt: "Build" }
    const task = await Effect.runPromise(store.createDelegation(input, target.id, "owner"))
    await Effect.runPromise(store.requestCancellation(task.id))
    const next = await Effect.runPromise(
      store.createDelegation({ prompt: "Other work" }, target.id, "owner"),
    )
    await Effect.runPromise(store.requestCancellation(next.id))
    await expect(Effect.runPromise(store.findDelegation(input, "owner"))).rejects.toMatchObject({
      status: 410,
    })
    await expect(
      Effect.runPromise(store.createDelegation(input, target.id, "owner")),
    ).rejects.toMatchObject({ status: 410 })
    expect((await Effect.runPromise(store.inboxFor("owner"))).items.map(({ id }) => id)).toEqual([
      next.id,
    ])
  } finally {
    await runtime.dispose()
  }
})
