import {
  AnswerTaskInput,
  RequestTaskInput,
  Device,
  makeDeviceId,
  now,
  Timestamp,
  taskDeadlineError,
} from "@cohall/protocol"
import { Effect, ManagedRuntime, Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { RelayStore } from "./store.ts"

afterEach(() => vi.useRealTimers())

it("preserves deadlines through clarification and restart, expires queued work, and waits for active cancellation", async () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime("2030-01-01T00:00:00Z")
  const directory = await mkdtemp(join(tmpdir(), "cohall-deadlines-"))
  const database = join(directory, "relay.db")
  let runtime = ManagedRuntime.make(RelayStore.layer(database))
  try {
    const store = await runtime.runPromise(RelayStore.Service)
    const target = Device.make({
      id: makeDeviceId(),
      name: "deadline-worker",
      hostname: "localhost",
      platform: "linux",
      architecture: "x64",
      status: "online",
      providers: ["codex"],
      capabilities: [
        { id: "task-deadlines", label: "Deadlines" },
        { id: "task-clarification", label: "Clarification" },
      ],
      workspaces: [],
      version: "test",
      lastSeenAt: now(),
    })
    await Effect.runPromise(store.upsertDevice(target))
    const expiresAt = Timestamp.make("2030-01-01T00:00:01.000Z")
    const resumed = await Effect.runPromise(
      store.createDelegation({ prompt: "Work", expiresAt }, target.id, "owner"),
    )
    const assigned = await Effect.runPromise(store.assignTask(resumed.id))
    const runId = assigned.runId
    if (runId === undefined) throw new Error("Missing run")
    await Effect.runPromise(store.acceptTask(resumed.id, target.id, runId))
    const question = await Effect.runPromise(
      store.requestTaskInput(
        resumed.id,
        target.id,
        Schema.decodeUnknownSync(RequestTaskInput)({ runId, question: "Which branch?" }),
      ),
    )
    await Effect.runPromise(
      store.finishTask(resumed.id, target.id, "Asked", "session", undefined, runId),
    )
    const answered = await Effect.runPromise(
      store.answerTaskInput(
        resumed.id,
        "owner",
        Schema.decodeUnknownSync(AnswerTaskInput)({ requestId: question.id, answer: "main" }),
      ),
    )
    expect(answered.expiresAt).toBe(expiresAt)
    const queued = await Effect.runPromise(
      store.createDelegation({ prompt: "Still queued", expiresAt }, target.id, "owner"),
    )
    const manual = await Effect.runPromise(
      store.createDelegation({ prompt: "Cancel manually", expiresAt }, target.id, "owner"),
    )
    const manualAssigned = await Effect.runPromise(store.assignTask(manual.id))
    await Effect.runPromise(store.requestCancellation(manual.id))
    await runtime.dispose()
    runtime = ManagedRuntime.make(RelayStore.layer(database))
    const restored = await runtime.runPromise(RelayStore.Service)
    await Effect.runPromise(restored.recover())
    vi.setSystemTime("2030-01-01T00:00:01.001Z")
    await Effect.runPromise(restored.expireTasks())
    expect(await Effect.runPromise(restored.getTask(queued.id))).toMatchObject({
      status: "failed",
      error: taskDeadlineError,
      expiresAt,
    })
    const cancelling = await Effect.runPromise(restored.getTask(resumed.id))
    expect(cancelling).toMatchObject({ status: "cancelling", error: taskDeadlineError, expiresAt })
    await expect(
      Effect.runPromise(
        restored.answerTaskInput(
          resumed.id,
          "owner",
          Schema.decodeUnknownSync(AnswerTaskInput)({
            requestId: question.id,
            answer: "another branch",
          }),
        ),
      ),
    ).rejects.toMatchObject({ status: 409, message: taskDeadlineError })
    await expect(
      Effect.runPromise(
        restored.requestTaskInput(
          resumed.id,
          target.id,
          Schema.decodeUnknownSync(RequestTaskInput)({
            runId,
            question: "Another question?",
          }),
        ),
      ),
    ).rejects.toMatchObject({ status: 409, message: taskDeadlineError })
    expect(
      (
        await Effect.runPromise(
          restored.finishTask(
            resumed.id,
            target.id,
            "Late",
            undefined,
            undefined,
            cancelling.runId,
          ),
        )
      ).status,
    ).toBe("cancelling")
    expect(
      await Effect.runPromise(
        restored.acknowledgeCancellation(resumed.id, target.id, cancelling.runId),
      ),
    ).toMatchObject({ status: "failed", error: taskDeadlineError })
    expect(
      (
        await Effect.runPromise(
          restored.acknowledgeCancellation(manual.id, target.id, manualAssigned.runId),
        )
      ).status,
    ).toBe("cancelled")
    expect((await Effect.runPromise(restored.traceTask(resumed.id))).expiresAt).toBe(expiresAt)
    expect(
      (await Effect.runPromise(restored.inboxFor("owner"))).items.map((item) => item.status),
    ).toEqual(expect.arrayContaining(["failed", "failed", "cancelled"]))
  } finally {
    await runtime.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it("rejects past deadlines and Bot deadlines before creating work", async () => {
  const runtime = ManagedRuntime.make(RelayStore.layer(":memory:"))
  try {
    const store = await runtime.runPromise(RelayStore.Service)
    await expect(
      Effect.runPromise(
        store.createDelegation(
          { prompt: "Old", expiresAt: Timestamp.make("2000-01-01T00:00:00Z") },
          makeDeviceId(),
          "owner",
        ),
      ),
    ).rejects.toMatchObject({ status: 400, message: "Task deadline must be in the future" })
    await expect(
      Effect.runPromise(
        store.createDelegation(
          {
            prompt: "Bot",
            provider: "grok-bot",
            expiresAt: Timestamp.make("2100-01-01T00:00:00Z"),
          },
          makeDeviceId(),
          "owner",
        ),
      ),
    ).rejects.toMatchObject({ status: 400, message: "Task deadlines require a coding provider" })
  } finally {
    await runtime.dispose()
  }
})
