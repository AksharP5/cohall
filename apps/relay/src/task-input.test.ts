import {
  AnswerTaskInput,
  BotId,
  ClarificationId,
  Device,
  RequestTaskInput,
  makeDeviceId,
  now,
  version,
} from "@cohall/protocol"
import { Effect, ManagedRuntime, Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { RelayStore } from "./store.ts"

const worker = () =>
  Device.make({
    id: makeDeviceId(),
    name: "input-target",
    hostname: "localhost",
    platform: "linux",
    architecture: "x64",
    status: "online",
    providers: ["codex"],
    capabilities: [{ id: "task-clarification", label: "Clarification" }],
    workspaces: [],
    version,
    lastSeenAt: now(),
  })

it("cancels a resumed Bot turn that has not been dispatched", async () => {
  const runtime = ManagedRuntime.make(RelayStore.layer(":memory:"))
  try {
    const store = await runtime.runPromise(RelayStore.Service)
    const botId = BotId.make("research-bot")
    const target = Device.make({
      ...worker(),
      providers: ["grok-bot"],
      bots: [{ id: botId, name: "Research" }],
    })
    await Effect.runPromise(store.upsertDevice(target))
    const task = await Effect.runPromise(
      store.createDelegation({ prompt: "Research", botId }, target.id, "owner"),
    )
    const assigned = await Effect.runPromise(store.assignTask(task.id))
    const runId = assigned.runId
    if (runId === undefined) throw new Error("Missing turn")
    await Effect.runPromise(store.markTaskDispatched(task.id))
    await Effect.runPromise(store.acceptTask(task.id, target.id, runId))
    const question = await Effect.runPromise(
      store.requestTaskInput(
        task.id,
        target.id,
        Schema.decodeUnknownSync(RequestTaskInput)({ runId, question: "Which topic?" }),
      ),
    )
    await Effect.runPromise(store.finishTask(task.id, target.id, "", undefined, undefined, runId))
    const resumed = await Effect.runPromise(
      store.answerTaskInput(
        task.id,
        "owner",
        Schema.decodeUnknownSync(AnswerTaskInput)({
          requestId: question.id,
          answer: "Release tooling",
        }),
      ),
    )
    expect(resumed.startedAt).toBeUndefined()
    expect((await Effect.runPromise(store.requestCancellation(task.id))).status).toBe("cancelled")
  } finally {
    await runtime.dispose()
  }
})

it("pauses, frees the worker, and resumes only the current question for its requester", async () => {
  const runtime = ManagedRuntime.make(RelayStore.layer(":memory:"))
  try {
    const store = await runtime.runPromise(RelayStore.Service)
    const target = worker()
    await Effect.runPromise(store.upsertDevice(target))
    const pair = async (label: string) => {
      const invite = await Effect.runPromise(store.createPairing({ label, roles: ["client"] }))
      const joined = await Effect.runPromise(store.exchangePairing(invite.token))
      const session = joined.credentials[0]?.session
      if (session === undefined) throw new Error("Missing test session")
      return session
    }
    const sender = await pair("Sender")
    const other = await pair("Other sender")
    const task = await Effect.runPromise(
      store.createDelegation({ prompt: "Ship the change" }, target.id, sender),
    )
    const assigned = await Effect.runPromise(store.assignTask(task.id))
    const runId = assigned.runId
    if (runId === undefined) throw new Error("Missing worker turn")
    await Effect.runPromise(store.acceptTask(task.id, target.id, runId))
    const input = Schema.decodeUnknownSync(RequestTaskInput)({ runId, question: "Which branch?" })
    await expect(
      Effect.runPromise(store.requestTaskInput(task.id, makeDeviceId(), input)),
    ).rejects.toMatchObject({ status: 403 })
    const question = await Effect.runPromise(store.requestTaskInput(task.id, target.id, input))
    expect(await Effect.runPromise(store.requestTaskInput(task.id, target.id, input))).toEqual(
      question,
    )
    const answer = Schema.decodeUnknownSync(AnswerTaskInput)({
      requestId: question.id,
      answer: "Use main",
    })
    await expect(
      Effect.runPromise(store.answerTaskInput(task.id, sender, answer)),
    ).rejects.toMatchObject({ status: 409 })
    const paused = await Effect.runPromise(
      store.finishTask(
        task.id,
        target.id,
        "Asked a question",
        "provider-session",
        undefined,
        runId,
      ),
    )
    expect(paused).toMatchObject({
      id: task.id,
      status: "needs_input",
      providerSessionId: "provider-session",
      clarifications: [question],
    })
    expect(paused.result).toBeUndefined()
    expect(await Effect.runPromise(store.inboxFor(sender))).toMatchObject({
      items: [{ id: task.id, status: "needs_input", inputRequest: question }],
    })
    await expect(
      Effect.runPromise(store.acknowledgeCompletion(task.id, sender)),
    ).rejects.toMatchObject({ message: `Unknown inbox task ${task.id}` })
    const another = await Effect.runPromise(
      store.createDelegation({ prompt: "Other work" }, target.id, other),
    )
    expect((await Effect.runPromise(store.assignTask(another.id))).status).toBe("assigned")
    await Effect.runPromise(store.finishTask(another.id, target.id, "Done"))
    await expect(
      Effect.runPromise(store.answerTaskInput(task.id, other, answer)),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      Effect.runPromise(
        store.answerTaskInput(task.id, sender, {
          ...answer,
          requestId: ClarificationId.make(crypto.randomUUID()),
        }),
      ),
    ).rejects.toMatchObject({ status: 409 })
    const resumed = await Effect.runPromise(store.answerTaskInput(task.id, sender, answer))
    expect(resumed).toMatchObject({
      id: task.id,
      threadId: task.threadId,
      status: "queued",
      providerSessionId: "provider-session",
      clarifications: [{ ...question, answer: { text: "Use main" } }],
    })
    expect(resumed.runId).not.toBe(runId)
    await expect(
      Effect.runPromise(store.answerTaskInput(task.id, sender, answer)),
    ).rejects.toMatchObject({ status: 409 })
    expect((await Effect.runPromise(store.inboxFor(sender))).items).toEqual([])
    expect(
      (
        await Effect.runPromise(
          store.finishTask(task.id, target.id, "Old result", undefined, undefined, runId),
        )
      ).status,
    ).toBe("queued")
    expect(
      (await Effect.runPromise(store.finishTask(task.id, target.id, "Unidentified old result")))
        .status,
    ).toBe("queued")
    const next = await Effect.runPromise(store.assignTask(task.id))
    await Effect.runPromise(store.acceptTask(task.id, target.id, next.runId))
    const finished = await Effect.runPromise(
      store.finishTask(task.id, target.id, "Shipped", "provider-session", undefined, next.runId),
    )
    expect(finished).toMatchObject({ status: "completed", result: "Shipped" })
    expect((await Effect.runPromise(store.inboxFor(sender))).items[0]?.status).toBe("completed")
    expect(
      (await Effect.runPromise(store.traceTask(task.id))).events.map((event) => event.kind),
    ).toContain("input_answered")
  } finally {
    await runtime.dispose()
  }
})

it("preserves an unanswered question across disconnect and relay restart, and cancels paused work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-input-"))
  const database = join(directory, "relay.db")
  const original = ManagedRuntime.make(RelayStore.layer(database))
  let restored: typeof original | undefined
  try {
    const store = await original.runPromise(RelayStore.Service)
    const target = worker()
    await Effect.runPromise(store.upsertDevice(target))
    const task = await Effect.runPromise(
      store.createDelegation({ prompt: "Build" }, target.id, "owner"),
    )
    const assigned = await Effect.runPromise(store.assignTask(task.id))
    if (assigned.runId === undefined) throw new Error("Missing turn")
    await Effect.runPromise(store.acceptTask(task.id, target.id, assigned.runId))
    const question = await Effect.runPromise(
      store.requestTaskInput(
        task.id,
        target.id,
        Schema.decodeUnknownSync(RequestTaskInput)({
          runId: assigned.runId,
          question: "Which environment?",
        }),
      ),
    )
    await Effect.runPromise(store.requeueTasksFor(target.id))
    expect((await Effect.runPromise(store.getTask(task.id))).status).toBe("needs_input")
    await original.dispose()
    restored = ManagedRuntime.make(RelayStore.layer(database))
    const recovered = await restored.runPromise(RelayStore.Service)
    await Effect.runPromise(recovered.recover())
    expect((await Effect.runPromise(recovered.getTask(task.id))).clarifications).toEqual([question])
    expect((await Effect.runPromise(recovered.pendingTasksFor(target.id))).length).toBe(0)
    expect((await Effect.runPromise(recovered.usage())).byStatus.needs_input).toBe(1)
    expect((await Effect.runPromise(recovered.requestCancellation(task.id))).status).toBe(
      "cancelled",
    )
    await expect(
      Effect.runPromise(
        recovered.answerTaskInput(
          task.id,
          "owner",
          Schema.decodeUnknownSync(AnswerTaskInput)({
            requestId: question.id,
            answer: "Production",
          }),
        ),
      ),
    ).rejects.toMatchObject({ status: 409 })
  } finally {
    await original.dispose()
    await restored?.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
