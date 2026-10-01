import { createServer } from "node:http"
import { type AddressInfo } from "node:net"
import { Effect } from "effect"
import { expect, it, vi } from "vitest"
import { make } from "./index.ts"
import {
  RequestTaskInput,
  TaskProgressInput,
  Timestamp,
  TaskRequestId,
  makeTaskId,
} from "@cohall/protocol"
import { Schema } from "effect"

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
