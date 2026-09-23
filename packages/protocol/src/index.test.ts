import { Effect, Schema } from "effect"
import { expect, it } from "vitest"
import {
  BotId,
  CreateTaskInput,
  CreateUpgradeOperationsInput,
  SocketEvent,
  Task,
  assertDeviceOperationSupport,
  decodeCreateTaskInput,
  makeDeviceId,
  makeTaskId,
  makeThreadId,
  maxSocketPayloadBytes,
  now,
  supportsDeviceOperations,
  taskSlot,
} from "./index.ts"

it("infers the Grok provider from a bot and rejects incompatible task targets", async () => {
  const botId = BotId.make("bot-reacher")
  await expect(
    Effect.runPromise(decodeCreateTaskInput({ prompt: "Hello", botId })),
  ).resolves.toEqual({
    prompt: "Hello",
    botId,
    provider: "grok-bot",
  })
  for (const input of [
    { prompt: "Hello", provider: "grok-bot" },
    { prompt: "Hello", provider: "codex", botId },
    { prompt: "Hello", provider: "grok-bot", botId, workspace: "/workspace" },
    { prompt: "Hello", botId: "" },
    { prompt: "Hello", botId: "x".repeat(257) },
  ]) {
    expect(() => Schema.decodeUnknownSync(CreateTaskInput)(input)).toThrow()
  }
  expect(taskSlot({ provider: "grok-bot", botId })).toBe("grok-bot:bot-reacher")
  expect(taskSlot({ provider: "codex" })).toBe(taskSlot({ provider: "claude-code" }))
})

it("keeps bot target invariants on assigned tasks and accepts roster-clearing heartbeats", () => {
  const task = {
    id: makeTaskId(),
    threadId: makeThreadId(),
    prompt: "Hello",
    provider: "grok-bot",
    status: "queued",
    targetDeviceId: makeDeviceId(),
    createdAt: now(),
    updatedAt: now(),
  }
  expect(() => Schema.decodeUnknownSync(Task)(task)).toThrow()
  expect(Schema.decodeUnknownSync(Task)({ ...task, botId: "bot-reacher" }).botId).toBe(
    "bot-reacher",
  )
  expect(
    Schema.decodeUnknownSync(SocketEvent)({
      _tag: "DeviceHeartbeat",
      deviceId: task.targetDeviceId,
      status: "online",
      bots: [],
    }),
  ).toHaveProperty("bots", [])
})

it("requires the device-operation protocol before queuing all-device work", () => {
  expect(supportsDeviceOperations("0.4.10")).toBe(false)
  expect(supportsDeviceOperations("0.5.0-beta.1")).toBe(false)
  expect(supportsDeviceOperations("0.5.0")).toBe(true)
  expect(supportsDeviceOperations("0.6.0-beta.1")).toBe(true)
  expect(supportsDeviceOperations("0.0.0-development")).toBe(true)
  expect(() =>
    assertDeviceOperationSupport([
      { name: "current", version: "0.5.0" },
      { name: "legacy", version: "0.4.10" },
    ]),
  ).toThrow("Upgrade individually first: legacy (0.4.10)")
})

it("allows only explicit versions in all-device upgrades", async () => {
  await expect(
    Effect.runPromise(
      Schema.decodeUnknownEffect(CreateUpgradeOperationsInput)({
        target: "1.2.3",
        restart: true,
      }),
    ),
  ).resolves.toEqual({ target: "1.2.3", restart: true })
  await expect(
    Effect.runPromise(
      Schema.decodeUnknownEffect(CreateUpgradeOperationsInput)({
        target: "next; reboot",
        restart: true,
      }),
    ),
  ).rejects.toBeDefined()
})

const encodedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))

it("fits every maximum task transport event inside the shared socket budget", () => {
  const taskId = makeTaskId()
  const assignment = SocketEvent.make({
    _tag: "TaskAssigned",
    task: Task.make({
      id: taskId,
      threadId: makeThreadId(),
      prompt: "p".repeat(131_072),
      context: "c".repeat(131_072),
      provider: "codex",
      status: "queued",
      targetDeviceId: makeDeviceId(),
      workspace: "w".repeat(4_096),
      createdAt: now(),
      updatedAt: now(),
    }),
  })
  const completion = SocketEvent.make({
    _tag: "TaskFinished",
    taskId,
    result: "\0".repeat(131_072),
    providerSessionId: "s".repeat(4_096),
  })

  expect(encodedBytes(assignment)).toBeLessThan(maxSocketPayloadBytes)
  expect(encodedBytes(completion)).toBeLessThan(maxSocketPayloadBytes)
})
