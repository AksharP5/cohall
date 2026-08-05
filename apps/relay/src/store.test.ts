import { Device, DeviceId, now, version } from "@cohall/protocol"
import { Effect, ManagedRuntime } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
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
