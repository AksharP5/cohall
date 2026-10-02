import { createServer } from "node:http"
import { type AddressInfo } from "node:net"
import { Effect } from "effect"
import { expect, it, vi } from "vitest"
import { make } from "./index.ts"
import {
  Device,
  RequestTaskInput,
  TaskTrace,
  TaskProgressInput,
  Timestamp,
  TaskRequestId,
  makeDeviceId,
  makeTaskId,
  makeThreadId,
  now,
} from "@cohall/protocol"
import { Schema } from "effect"

const largeTrace = () => {
  const at = now()
  const device = Schema.decodeUnknownSync(Device)({
    id: makeDeviceId(),
    name: "target",
    hostname: "localhost",
    platform: "linux",
    architecture: "x64",
    status: "online",
    providers: ["codex"],
    capabilities: [
      { id: "task-clarification", label: "Clarification", detail: "\0".repeat(512) },
      ...Array.from({ length: 63 }, (_, index) => ({
        id: `cap${index}`,
        label: "x",
        detail: "\0".repeat(512),
      })),
    ],
    workspaces: Array.from({ length: 64 }, () => ({
      path: "\\".repeat(4096),
      label: "\0".repeat(256),
    })),
    version: "0.9.0",
    lastSeenAt: at,
  })
  const bots = Array.from({ length: 256 }, (_, index) => ({
    id: `bot${index}`,
    name: "x",
    description: "\0".repeat(512),
  }))
  const trace = Schema.decodeUnknownSync(TaskTrace)({
    taskId: makeTaskId(),
    threadId: makeThreadId(),
    status: "completed",
    provider: "codex",
    targetDevice: { ...device, bots },
    createdAt: at,
    updatedAt: at,
    completedAt: at,
    events: [],
    truncated: false,
    clarifications: Array.from({ length: 10 }, () => ({
      id: crypto.randomUUID(),
      question: `q${"\0".repeat(4095)}`,
      at,
      answer: { text: `a${"\0".repeat(4095)}`, at },
    })),
  })
  expect(Buffer.byteLength(JSON.stringify({ _tag: "DeviceHello", device }))).toBeLessThan(
    1024 * 1024,
  )
  expect(
    Buffer.byteLength(
      JSON.stringify({ _tag: "DeviceHeartbeat", deviceId: device.id, status: "online", bots }),
    ),
  ).toBeLessThan(1024 * 1024)
  return trace
}

it("reads a completed trace built from accepted device updates and clarification rounds", async () => {
  const trace = largeTrace()
  const payload = JSON.stringify(trace)
  expect(Buffer.byteLength(payload)).toBeGreaterThan(2 * 1024 * 1024)
  expect(Buffer.byteLength(payload)).toBeLessThan(4 * 1024 * 1024)
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(payload))
  try {
    const client = make({ baseUrl: "http://relay.test", token: "test" })
    const received = await Effect.runPromise(client.traceTask(trace.taskId))
    expect(received.taskId).toBe(trace.taskId)
    expect(received.status).toBe("completed")
    expect(received.clarifications).toHaveLength(10)
    expect(received.targetDevice.bots).toHaveLength(256)
  } finally {
    fetch.mockRestore()
  }
})

it("rejects a trace response over 4 MiB", async () => {
  const trace = largeTrace()
  const payload = JSON.stringify(trace)
  const padded = `${payload}${" ".repeat(4 * 1024 * 1024 + 1 - Buffer.byteLength(payload))}`
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(padded))
  try {
    const client = make({ baseUrl: "http://relay.test", token: "test" })
    await expect(Effect.runPromise(client.traceTask(trace.taskId))).rejects.toMatchObject({
      message: "Relay response exceeded 4 MiB",
    })
  } finally {
    fetch.mockRestore()
  }
})

it("keeps the 2 MiB limit for ordinary JSON responses", async () => {
  const device = largeTrace().targetDevice
  const payload = JSON.stringify([device, { ...device, id: makeDeviceId() }])
  expect(Buffer.byteLength(payload)).toBeGreaterThan(2 * 1024 * 1024)
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(payload))
  try {
    const client = make({ baseUrl: "http://relay.test", token: "test" })
    await expect(Effect.runPromise(client.devices())).rejects.toMatchObject({
      message: "Relay response exceeded 2 MiB",
    })
  } finally {
    fetch.mockRestore()
  }
})

it.each([200, 503])("closes a partial %s response when its caller cancels", async (status) => {
  const headersReceived = Promise.withResolvers<void>()
  const originalFetch = globalThis.fetch
  let responseClosed = false
  const server = createServer((_request, response) => {
    response.once("close", () => {
      responseClosed = true
    })
    response.writeHead(status, { "content-type": "application/json" })
    response.write("{")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const controller = new AbortController()
  try {
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("Missing test port")
    vi.stubGlobal("fetch", async (...arguments_: Parameters<typeof fetch>) => {
      const response = await originalFetch(...arguments_)
      headersReceived.resolve()
      return response
    })
    const client = make({ baseUrl: `http://127.0.0.1:${address.port}`, token: "test" })
    const running = Effect.runPromise(client.getTask(makeTaskId()), { signal: controller.signal })
    const rejected = expect(running).rejects.toBeDefined()
    await headersReceived.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    controller.abort()
    await rejected
    await vi.waitFor(() => expect(responseClosed).toBe(true))
  } finally {
    controller.abort()
    vi.unstubAllGlobals()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it("refuses progress, clarification, and keyed submissions against older relays", async () => {
  let posted = false
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json")
    if (request.url === "/api/health") {
      response.end(JSON.stringify({ ok: true }))
      return
    }
    posted = true
    response.writeHead(404).end("{}")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("Missing test port")
    const client = make({ baseUrl: `http://127.0.0.1:${address.port}`, token: "test" })
    await expect(
      Effect.runPromise(
        client.createTask({
          requestId: TaskRequestId.make(crypto.randomUUID()),
          prompt: "Build",
        }),
      ),
    ).rejects.toMatchObject({ message: "Upgrade the Cohall relay before using task request IDs" })
    await expect(
      Effect.runPromise(
        client.reportTaskProgress(
          makeTaskId(),
          Schema.decodeUnknownSync(TaskProgressInput)({ note: "Testing" }),
        ),
      ),
    ).rejects.toMatchObject({
      message: "Upgrade the Cohall relay before reporting task progress",
    })
    await expect(
      Effect.runPromise(
        client.requestTaskInput(
          makeTaskId(),
          Schema.decodeUnknownSync(RequestTaskInput)({
            runId: crypto.randomUUID(),
            question: "Which branch?",
          }),
        ),
      ),
    ).rejects.toMatchObject({
      message: "Upgrade the Cohall relay before requesting clarification",
    })
    expect(posted).toBe(false)
    await expect(
      Effect.runPromise(
        client.createTask({
          prompt: "Deadline",
          expiresAt: Timestamp.make("2100-01-01T00:00:00Z"),
        }),
      ),
    ).rejects.toMatchObject({ message: "Upgrade the Cohall relay before using task deadlines" })
    expect(posted).toBe(false)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it("rejects files before submitting to a relay without attachment support", async () => {
  let created = false
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json")
    if (request.url === "/api/health") {
      response.end(JSON.stringify({ ok: true, version: "0.6.2" }))
      return
    }
    created = true
    response.writeHead(500).end("{}")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const port = (server.address() as AddressInfo).port
    const client = make({ baseUrl: `http://127.0.0.1:${port}`, token: "test" })
    await expect(
      Effect.runPromise(
        client.createTask({
          prompt: "Inspect",
          attachments: [{ name: "image.png", data: Buffer.from("image").toString("base64") }],
        }),
      ),
    ).rejects.toMatchObject({ message: "Upgrade the Cohall relay before sending file attachments" })
    expect(created).toBe(false)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
