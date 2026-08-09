import { expect, it } from "vitest"
import {
  SocketEvent,
  Task,
  makeDeviceId,
  makeTaskId,
  makeThreadId,
  maxSocketPayloadBytes,
  now,
} from "./index.ts"

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
