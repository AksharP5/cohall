import {
  AnswerTaskInput,
  BotId,
  ClarificationId,
  Device,
  RequestTaskInput,
  TaskRunId,
  makeDeviceId,
  maxTaskClarifications,
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

it.each(["running", "queued", "assigned"] as const)(
  "settles an ended Bot turn at the clarification limit while %s",
  async (status) => {
    const runtime = ManagedRuntime.make(RelayStore.layer(":memory:"))
    try {
      const store = await runtime.runPromise(RelayStore.Service)
      const botId = BotId.make("question-limit-bot")
      const target = Device.make({
        ...worker(),
        providers: ["grok-bot"],
        bots: [{ id: botId, name: "Research" }],
      })
      await Effect.runPromise(store.upsertDevice(target))
      const task = await Effect.runPromise(
        store.createDelegation({ prompt: "Research", botId }, target.id, "owner"),
      )
      for (let index = 0; index < maxTaskClarifications; index += 1) {
        const assigned = await Effect.runPromise(store.assignTask(task.id))
        if (assigned.runId === undefined) throw new Error("Missing Bot turn")
        await Effect.runPromise(store.acceptTask(task.id, target.id, assigned.runId))
        const input = Schema.decodeUnknownSync(RequestTaskInput)({
          runId: assigned.runId,
          question: `Question ${index + 1}?`,
        })
        // The final allowed question can already be recorded when its terminal reply arrives.
        if (index === maxTaskClarifications - 1) {
          await Effect.runPromise(store.requestTaskInput(task.id, target.id, input))
        }
        const paused = await Effect.runPromise(store.pauseTaskForInput(task.id, target.id, input))
        expect(paused.status).toBe("needs_input")
        const question = paused.clarifications?.at(-1)
        if (question === undefined) throw new Error("Missing question")
        await Effect.runPromise(
          store.answerTaskInput(
            task.id,
            "owner",
            Schema.decodeUnknownSync(AnswerTaskInput)({ requestId: question.id, answer: "Yes" }),
          ),
        )
      }
      const assigned = await Effect.runPromise(store.assignTask(task.id))
      if (assigned.runId === undefined) throw new Error("Missing Bot turn")
      await Effect.runPromise(store.acceptTask(task.id, target.id, assigned.runId))
      const input = Schema.decodeUnknownSync(RequestTaskInput)({
        runId: assigned.runId,
        question: "One more question?",
      })
      const error = `A task supports at most ${maxTaskClarifications} clarifications`
      await expect(
        Effect.runPromise(store.requestTaskInput(task.id, target.id, input)),
      ).rejects.toMatchObject({ status: 409, message: error })
      if (status !== "running") await Effect.runPromise(store.requeueTasksFor(target.id))
      if (status === "assigned") await Effect.runPromise(store.assignTask(task.id))
      await expect(
        Effect.runPromise(store.pauseTaskForInput(task.id, makeDeviceId(), input)),
      ).rejects.toMatchObject({ message: `Task ${task.id} belongs to another device` })
      expect(
        (
          await Effect.runPromise(
            store.pauseTaskForInput(task.id, target.id, {
              ...input,
              runId: TaskRunId.make(crypto.randomUUID()),
            }),
          )
        ).status,
      ).toBe(status)
      const followup = await Effect.runPromise(
        store.createDelegation({ prompt: "Next task", botId }, target.id, "owner"),
      )
      if (status !== "queued") {
        expect((await Effect.runPromise(store.assignTask(followup.id))).status).toBe("queued")
      }
      const failed = await Effect.runPromise(store.pauseTaskForInput(task.id, target.id, input))
      expect(failed).toMatchObject({ status: "failed", error })
      expect(failed.clarifications).toHaveLength(maxTaskClarifications)
      expect(await Effect.runPromise(store.pauseTaskForInput(task.id, target.id, input))).toEqual(
        failed,
      )
      expect((await Effect.runPromise(store.inboxFor("owner"))).items).toContainEqual(
        expect.objectContaining({
          id: task.id,
          status: "failed",
          errorPreview: error,
        }),
      )
      expect((await Effect.runPromise(store.assignTask(followup.id))).status).toBe("assigned")
    } finally {
      await runtime.dispose()
    }
  },
)

it.each(["queued", "assigned"] as const)(
  "saves an offline Bot question while its replayed turn is %s",
  async (status) => {
    const runtime = ManagedRuntime.make(RelayStore.layer(":memory:"))
    try {
      const store = await runtime.runPromise(RelayStore.Service)
      const botId = BotId.make("offline-bot")
      const target = Device.make({
        ...worker(),
        providers: ["grok-bot"],
        bots: [{ id: botId, name: "Offline" }],
      })
      await Effect.runPromise(store.upsertDevice(target))
      const task = await Effect.runPromise(
        store.createDelegation({ prompt: "Research", botId }, target.id, "owner"),
      )
      const assigned = await Effect.runPromise(store.assignTask(task.id))
      if (assigned.runId === undefined) throw new Error("Missing Bot turn")
      const running = await Effect.runPromise(store.acceptTask(task.id, target.id, assigned.runId))
      await Effect.runPromise(store.requeueTasksFor(target.id))
      if (status === "assigned") await Effect.runPromise(store.assignTask(task.id))
      const input = Schema.decodeUnknownSync(RequestTaskInput)({
        runId: assigned.runId,
        question: "Which branch?",
      })
      await expect(
        Effect.runPromise(store.requestTaskInput(task.id, target.id, input)),
      ).rejects.toMatchObject({ status: 409 })
      await expect(
        Effect.runPromise(store.pauseTaskForInput(task.id, makeDeviceId(), input)),
      ).rejects.toMatchObject({ message: `Task ${task.id} belongs to another device` })
      const stale = { ...input, runId: TaskRunId.make(crypto.randomUUID()) }
      expect(
        (await Effect.runPromise(store.pauseTaskForInput(task.id, target.id, stale))).status,
      ).toBe(status)
      const paused = await Effect.runPromise(store.pauseTaskForInput(task.id, target.id, input))
      expect(paused).toMatchObject({
        status: "needs_input",
        startedAt: running.startedAt,
        clarifications: [{ question: input.question }],
      })
      expect(paused.result).toBeUndefined()
      expect(await Effect.runPromise(store.pauseTaskForInput(task.id, target.id, input))).toEqual(
        paused,
      )
      const question = paused.clarifications?.[0]
      if (question === undefined) throw new Error("Missing question")
      expect((await Effect.runPromise(store.inboxFor("owner"))).items[0]?.inputRequest).toEqual(
        question,
      )
      const answered = await Effect.runPromise(
        store.answerTaskInput(
          task.id,
          "owner",
          Schema.decodeUnknownSync(AnswerTaskInput)({ requestId: question.id, answer: "main" }),
        ),
      )
      expect(answered.runId).not.toBe(input.runId)
      if (answered.runId === undefined) throw new Error("Missing resumed turn")
      expect(await Effect.runPromise(store.pauseTaskForInput(task.id, target.id, input))).toEqual(
        answered,
      )
      const cancelled = await Effect.runPromise(store.requestCancellation(task.id))
      expect(
        await Effect.runPromise(
          store.pauseTaskForInput(task.id, target.id, { ...input, runId: answered.runId }),
        ),
      ).toEqual(cancelled)
    } finally {
      await runtime.dispose()
    }
  },
)

it.each(["failed", "cancelled"] as const)(
  "preserves a recorded question after a provider failure but honors %s termination",
  async (ending) => {
    const runtime = ManagedRuntime.make(RelayStore.layer(":memory:"))
    try {
      const store = await runtime.runPromise(RelayStore.Service)
      const target = worker()
      await Effect.runPromise(store.upsertDevice(target))
      const task = await Effect.runPromise(
        store.createDelegation({ prompt: "Build" }, target.id, "owner"),
      )
      const assigned = await Effect.runPromise(store.assignTask(task.id))
      const runId = assigned.runId
      if (runId === undefined) throw new Error("Missing turn")
      await Effect.runPromise(store.acceptTask(task.id, target.id, runId))
      const question = await Effect.runPromise(
        store.requestTaskInput(
          task.id,
          target.id,
          Schema.decodeUnknownSync(RequestTaskInput)({ runId, question: "Which branch?" }),
        ),
      )
      if (ending === "cancelled") await Effect.runPromise(store.requestCancellation(task.id))
      const settled = await Effect.runPromise(
        ending === "failed"
          ? store.failTask(task.id, target.id, "Provider crashed after requesting input", runId)
          : store.acknowledgeCancellation(task.id, target.id, runId),
      )
      expect(settled.status).toBe(ending === "failed" ? "needs_input" : "cancelled")
      const answer = Schema.decodeUnknownSync(AnswerTaskInput)({
        requestId: question.id,
        answer: "main",
      })
      if (ending === "failed") {
        expect((await Effect.runPromise(store.inboxFor("owner"))).items[0]?.inputRequest).toEqual(
          question,
        )
        expect(
          (await Effect.runPromise(store.answerTaskInput(task.id, "owner", answer))).status,
        ).toBe("queued")
      } else {
        await expect(
          Effect.runPromise(store.answerTaskInput(task.id, "owner", answer)),
        ).rejects.toMatchObject({ status: 409 })
      }
    } finally {
      await runtime.dispose()
    }
  },
)

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

it.each([
  ["disconnect", "queued"],
  ["disconnect", "assigned"],
  ["restart", "queued"],
  ["restart", "assigned"],
] as const)(
  "waits for the interrupted turn's terminal reply after %s while %s, then saves its session",
  async (interruption, status) => {
    const directory = await mkdtemp(join(tmpdir(), "cohall-input-session-"))
    const database = join(directory, "relay.db")
    let runtime = ManagedRuntime.make(RelayStore.layer(database))
    try {
      const store = await runtime.runPromise(RelayStore.Service)
      const target = worker()
      await Effect.runPromise(store.upsertDevice(target))
      const task = await Effect.runPromise(
        store.createDelegation({ prompt: "Build" }, target.id, "owner"),
      )
      const assigned = await Effect.runPromise(store.assignTask(task.id))
      const runId = assigned.runId
      if (runId === undefined) throw new Error("Missing turn")
      await Effect.runPromise(store.acceptTask(task.id, target.id, runId))
      const question = await Effect.runPromise(
        store.requestTaskInput(
          task.id,
          target.id,
          Schema.decodeUnknownSync(RequestTaskInput)({ runId, question: "Which branch?" }),
        ),
      )
      await Effect.runPromise(
        interruption === "disconnect" ? store.requeueTasksFor(target.id) : store.recover(),
      )
      const interrupted = await Effect.runPromise(store.getTask(task.id))
      expect(interrupted).toMatchObject({ status: "queued", runId, clarifications: [question] })
      if (status === "assigned") {
        expect(await Effect.runPromise(store.assignTask(task.id))).toMatchObject({
          status,
          runId,
        })
      }
      await expect(
        Effect.runPromise(
          store.answerTaskInput(
            task.id,
            "owner",
            Schema.decodeUnknownSync(AnswerTaskInput)({ requestId: question.id, answer: "main" }),
          ),
        ),
      ).rejects.toMatchObject({ status: 409 })
      const stale = await Effect.runPromise(
        store.finishTask(
          task.id,
          target.id,
          "Old",
          "stale-session",
          undefined,
          TaskRunId.make(crypto.randomUUID()),
        ),
      )
      expect(stale.providerSessionId).toBeUndefined()
      const paused = await Effect.runPromise(
        store.finishTask(task.id, target.id, "Asked", "late-session", undefined, runId),
      )
      expect(paused).toMatchObject({ status: "needs_input", providerSessionId: "late-session" })
      expect(paused.result).toBeUndefined()
      await runtime.dispose()
      runtime = ManagedRuntime.make(RelayStore.layer(database))
      const restored = await runtime.runPromise(RelayStore.Service)
      await Effect.runPromise(restored.recover())
      const answered = await Effect.runPromise(
        restored.answerTaskInput(
          task.id,
          "owner",
          Schema.decodeUnknownSync(AnswerTaskInput)({
            requestId: question.id,
            answer: "main",
          }),
        ),
      )
      expect(answered.providerSessionId).toBe("late-session")
      expect((await Effect.runPromise(restored.assignTask(task.id))).providerSessionId).toBe(
        "late-session",
      )
    } finally {
      await runtime.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  },
)

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

it("preserves an interrupted questioning turn across disconnect and restart until cancellation acknowledgement", async () => {
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
    expect((await Effect.runPromise(store.getTask(task.id))).status).toBe("queued")
    await original.dispose()
    restored = ManagedRuntime.make(RelayStore.layer(database))
    const recovered = await restored.runPromise(RelayStore.Service)
    await Effect.runPromise(recovered.recover())
    expect((await Effect.runPromise(recovered.getTask(task.id))).clarifications).toEqual([question])
    expect(await Effect.runPromise(recovered.pendingTasksFor(target.id))).toMatchObject([
      { id: task.id, status: "queued", runId: assigned.runId },
    ])
    expect((await Effect.runPromise(recovered.usage())).byStatus.queued).toBe(1)
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
    expect(await Effect.runPromise(recovered.assignTask(task.id))).toMatchObject({
      status: "assigned",
      runId: assigned.runId,
    })
    expect((await Effect.runPromise(recovered.requestCancellation(task.id))).status).toBe(
      "cancelling",
    )
    await Effect.runPromise(recovered.requeueTasksFor(target.id))
    expect((await Effect.runPromise(recovered.pendingTasksFor(target.id)))[0]).toMatchObject({
      id: task.id,
      status: "cancelling",
      runId: assigned.runId,
    })
    expect(
      (
        await Effect.runPromise(
          recovered.finishTask(
            task.id,
            target.id,
            "Late result",
            "late-session",
            undefined,
            assigned.runId,
          ),
        )
      ).status,
    ).toBe("cancelling")
    expect(
      (
        await Effect.runPromise(
          recovered.failTask(task.id, target.id, "Late failure", assigned.runId),
        )
      ).status,
    ).toBe("cancelling")
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
    expect(
      (
        await Effect.runPromise(
          recovered.acknowledgeCancellation(task.id, target.id, assigned.runId),
        )
      ).status,
    ).toBe("cancelled")
  } finally {
    await original.dispose()
    await restored?.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
