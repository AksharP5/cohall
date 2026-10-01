import { RelayClient, RelayRequestError } from "@cohall/client"
import {
  BotId,
  Device,
  DeviceId,
  Task,
  TaskId,
  TaskRequestId,
  ThreadContext,
  ThreadId,
  Timestamp,
  type CreateTaskInput,
} from "@cohall/protocol"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it, vi } from "vitest"
import { ClientConfiguration } from "./config.ts"
import {
  acknowledgedTaskResult,
  createDelegation,
  listBots,
  taskResult,
  waitForTask,
} from "./delegation.ts"

const timestamp = Timestamp.make("2026-08-09T12:00:00.000Z")
const device = Device.make({
  id: DeviceId.make("11111111-1111-4111-8111-111111111111"),
  name: "cloud",
  hostname: "cloud.local",
  platform: "linux",
  architecture: "x64",
  status: "online",
  providers: ["codex", "grok-bot"],
  bots: [
    { id: BotId.make("research-id"), name: "Research", description: "Find new projects" },
    { id: BotId.make("writer-id"), name: "Writer" },
  ],
  capabilities: [],
  workspaces: [],
  version: "1.0.0",
  lastSeenAt: timestamp,
})
const task = Task.make({
  id: TaskId.make("22222222-2222-4222-8222-222222222222"),
  threadId: ThreadId.make("33333333-3333-4333-8333-333333333333"),
  targetDeviceId: device.id,
  provider: "grok-bot",
  botId: BotId.make("research-id"),
  prompt: "Find a project",
  status: "completed",
  createdAt: timestamp,
  updatedAt: timestamp,
})
const configuration = ClientConfiguration.make({ relayUrl: "http://localhost:8787", token: "test" })

const client = (devices: ReadonlyArray<Device> = [device], tasks: ReadonlyArray<Task> = []) => ({
  ...RelayClient.make({ baseUrl: configuration.relayUrl, token: configuration.token }),
  devices: vi.fn(() => Effect.succeed(devices)),
  createTask: vi.fn((input: CreateTaskInput) =>
    Effect.succeed(
      Task.make({
        id: task.id,
        threadId: task.threadId,
        targetDeviceId: device.id,
        provider: "codex",
        status: "queued",
        createdAt: timestamp,
        updatedAt: timestamp,
        ...input,
      }),
    ),
  ),
  threadContext: vi.fn(() =>
    Effect.succeed(
      ThreadContext.make({
        thread: {
          id: task.threadId,
          title: "Projects",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        messages: [],
        tasks,
        truncated: false,
      }),
    ),
  ),
})

it.each(["initial lookup", "poll"] as const)(
  "times out and interrupts an unfinished %s",
  async (phase) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        let polls = 0
        let failure: unknown
        let interrupted = false
        const relay = {
          ...client(),
          getTask: () => {
            polls += 1
            if (phase === "poll" && polls === 1)
              return Effect.succeed(Task.make({ ...task, status: "running" }))
            return Effect.never.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  interrupted = true
                }),
              ),
            )
          },
        }
        const initial =
          phase === "initial lookup" ? task.id : Task.make({ ...task, status: "queued" })
        const waiting = yield* waitForTask(relay, initial, 5).pipe(
          Effect.tapError((cause) =>
            Effect.sync(() => {
              failure = cause
            }),
          ),
          Effect.ignore,
          Effect.forkChild,
        )
        yield* TestClock.adjust("5 seconds")
        expect(failure).toMatchObject({
          _tag: "Cohall.TaskWaitTimeoutError",
          taskId: task.id,
        })
        if (phase === "initial lookup") {
          expect(failure).not.toHaveProperty("status")
          expect(failure).toMatchObject({
            message: expect.stringContaining("did not return its status"),
          })
        } else {
          expect(failure).toMatchObject({ status: "running" })
        }
        expect(interrupted).toBe(true)
        yield* Fiber.join(waiting)
      }).pipe(Effect.provide(TestClock.layer())),
    )
  },
)

it("requires an explicit target or provider for keyed thread follow-ups", async () => {
  const relay = client([], [task])
  await expect(
    Effect.runPromise(
      createDelegation(relay, configuration, {
        requestId: TaskRequestId.make(crypto.randomUUID()),
        threadId: task.threadId,
        prompt: "Follow up",
      }),
    ),
  ).rejects.toMatchObject({
    message: "With a request ID, select a target or provider explicitly for thread follow-ups",
  })
  expect(relay.createTask).not.toHaveBeenCalled()
  expect(relay.threadContext).not.toHaveBeenCalled()
})

it("returns successful work even when inbox acknowledgement is unavailable", async () => {
  const completed = Task.make({ ...task, completedAt: timestamp })
  const unavailable = {
    ...client(),
    acknowledgeCompletion: vi.fn(() =>
      Effect.fail(
        new RelayRequestError({ operation: "ack", message: "Route not found", status: 404 }),
      ),
    ),
  }
  expect(await acknowledgedTaskResult(unavailable, completed)).toEqual(taskResult(completed))

  const failed = {
    ...client(),
    acknowledgeCompletion: vi.fn(() =>
      Effect.fail(new RelayRequestError({ operation: "ack", message: "Relay unavailable" })),
    ),
  }
  expect(await acknowledgedTaskResult(failed, completed)).toMatchObject({
    status: "completed",
    inbox_warning: expect.stringContaining("Relay unavailable"),
  })
})

it("does not acknowledge a result after its requester cancelled", async () => {
  const controller = new AbortController()
  controller.abort(new Error("Requester cancelled"))
  const relay = {
    ...client(),
    acknowledgeCompletion: vi.fn(() =>
      Effect.fail(
        new RelayRequestError({ operation: "ack", message: "Unexpected acknowledgement" }),
      ),
    ),
  }
  await expect(acknowledgedTaskResult(relay, task, controller.signal)).rejects.toBe(
    controller.signal.reason,
  )
  expect(relay.acknowledgeCompletion).not.toHaveBeenCalled()
})

it("rejects requester cancellation during inbox acknowledgement instead of returning a warning", async () => {
  const controller = new AbortController()
  const started = Promise.withResolvers<void>()
  const relay = {
    ...client(),
    acknowledgeCompletion: vi.fn(() =>
      Effect.gen(function* () {
        started.resolve()
        return yield* Effect.never
      }),
    ),
  }
  const result = acknowledgedTaskResult(relay, task, controller.signal)
  await started.promise
  controller.abort(new Error("Requester cancelled"))
  await expect(result).rejects.toBe(controller.signal.reason)
})

describe("bot delegation", () => {
  it("discovers every bot with a stable target and host availability", () => {
    expect(listBots([Device.make({ ...device, status: "offline" })])).toEqual([
      {
        id: "research-id",
        name: "Research",
        description: "Find new projects",
        device_id: device.id,
        device_name: "cloud",
        status: "offline",
        target: `@${device.id}/research-id`,
      },
      {
        id: "writer-id",
        name: "Writer",
        device_id: device.id,
        device_name: "cloud",
        status: "offline",
        target: `@${device.id}/writer-id`,
      },
    ])
  })

  it("infers the bot provider by name, qualified name, or stable ID", async () => {
    const relay = client()
    for (const target of ["@research", "@cloud/Research", `@${device.id}/research-id`]) {
      const result = await Effect.runPromise(
        createDelegation(relay, configuration, {
          prompt: "Find a project",
          target,
        }),
      )
      expect(relay.createTask).toHaveBeenLastCalledWith({
        prompt: "Find a project",
        targetDeviceId: device.id,
        provider: "grok-bot",
        botId: "research-id",
      })
      expect(taskResult(result).bot_id).toBe("research-id")
    }
  })

  it("rejects name collisions and accepts an unambiguous bot or device ID", async () => {
    const other = Device.make({
      ...device,
      id: DeviceId.make("44444444-4444-4444-8444-444444444444"),
      name: "Research",
      hostname: "other.local",
      bots: [{ id: BotId.make("second-research-id"), name: "Research" }],
    })
    const relay = client([device, other])
    await expect(
      Effect.runPromise(
        createDelegation(relay, configuration, {
          prompt: "Hello",
          target: "@Research",
        }),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("ambiguous") })
    expect(relay.createTask).not.toHaveBeenCalled()
    await Effect.runPromise(
      createDelegation(relay, configuration, {
        prompt: "Hello",
        target: "@cloud/Research",
      }),
    )
    expect(relay.createTask).toHaveBeenLastCalledWith(
      expect.objectContaining({
        targetDeviceId: device.id,
        botId: "research-id",
      }),
    )
    await Effect.runPromise(
      createDelegation(relay, configuration, {
        prompt: "Hello",
        target: `@${other.id}`,
      }),
    )
    expect(relay.createTask).toHaveBeenLastCalledWith({ prompt: "Hello", targetDeviceId: other.id })
  })

  it("requires a specific bot and rejects an incompatible provider", async () => {
    const relay = client()
    await expect(
      Effect.runPromise(
        createDelegation(relay, configuration, {
          prompt: "Hello",
          target: "@Writer",
          provider: "codex",
        }),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("requires provider grok-bot") })
    await expect(
      Effect.runPromise(
        createDelegation(relay, configuration, {
          prompt: "Hello",
          target: "@cloud",
          provider: "grok-bot",
        }),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("Select a bot") })
    await expect(
      Effect.runPromise(
        createDelegation(relay, configuration, {
          prompt: "Hello",
          target: "@removed-bot",
        }),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("No Cohall device or bot") })
    expect(relay.createTask).not.toHaveBeenCalled()
  })

  it("keeps a listed stable target usable when another bot has that ID as its name", async () => {
    const relay = client([
      Device.make({
        ...device,
        bots: [
          { id: BotId.make("research-id"), name: "Renamed research" },
          { id: BotId.make("other-id"), name: "research-id" },
        ],
      }),
    ])
    await Effect.runPromise(
      createDelegation(relay, configuration, {
        prompt: "Hello",
        target: `@${device.id}/research-id`,
      }),
    )
    expect(relay.createTask).toHaveBeenCalledWith(expect.objectContaining({ botId: "research-id" }))
  })

  it("continues the named bot in an explicit thread after nested delegation", async () => {
    const nested = Task.make({
      id: TaskId.make("55555555-5555-4555-8555-555555555555"),
      threadId: task.threadId,
      targetDeviceId: device.id,
      provider: "codex",
      parentTaskId: task.id,
      prompt: "Implement the project",
      status: "completed",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    const relay = client([device], [task, nested])
    await Effect.runPromise(
      createDelegation(relay, configuration, {
        prompt: "Tell me more",
        threadId: task.threadId,
      }),
    )
    expect(relay.createTask).toHaveBeenCalledWith({
      prompt: "Tell me more",
      threadId: task.threadId,
      targetDeviceId: device.id,
      provider: "grok-bot",
      botId: "research-id",
    })
  })

  it("inherits delegation context without routing a child task back to its bot", async () => {
    const relay = client([device], [task])
    await Effect.runPromise(
      createDelegation(
        relay,
        {
          ...configuration,
          mcpThreadId: task.threadId,
          mcpTaskId: task.id,
        },
        { prompt: "Implement the project" },
      ),
    )
    expect(relay.threadContext).not.toHaveBeenCalled()
    expect(relay.createTask).toHaveBeenCalledWith({
      prompt: "Implement the project",
      threadId: task.threadId,
      parentTaskId: task.id,
    })
  })
})
