import { createServer } from "node:http"
import { type AddressInfo } from "node:net"
import { Effect } from "effect"
import { expect, it, vi } from "vitest"
import { exchangePairing, make } from "./index.ts"
import {
  Bot,
  BotId,
  Device,
  DeviceId,
  DevicePage,
  DeviceOverview,
  RequestTaskInput,
  TaskTrace,
  TaskProgressInput,
  Timestamp,
  TaskRequestId,
  makeDeviceId,
  makeTaskId,
  makeThreadId,
  maxDevicePageResponseBytes,
  now,
} from "@cohall/protocol"
import { Schema } from "effect"

const pageDevice = (index: number, name: string) =>
  Device.make({
    id: DeviceId.make(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
    name,
    hostname: "localhost",
    platform: "linux",
    architecture: "x64",
    status: "online",
    providers: ["grok-bot"],
    capabilities: [],
    workspaces: [],
    version: "0.9.0",
    lastSeenAt: now(),
  })

it("reads compact device status without fetching full rosters and rejects unsupported relays", async () => {
  const overview = DeviceOverview.make({
    ...pageDevice(1, "worker"),
    queued: 2,
    active: 1,
    needsInput: 1,
    cancelling: 0,
  })
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json([overview]))
  try {
    const client = make({ baseUrl: "http://relay.test", token: "test" })
    expect(await Effect.runPromise(client.deviceOverview())).toEqual([overview])
    expect(fetch.mock.calls[0]?.[0]).toBe("http://relay.test/api/devices/overview")
    fetch.mockResolvedValue(Response.json({ error: "Route not found" }, { status: 404 }))
    await expect(Effect.runPromise(client.deviceOverview())).rejects.toThrow("upgrade the relay")
    expect(fetch).toHaveBeenCalledTimes(2)
  } finally {
    fetch.mockRestore()
  }
})

it("assembles large device pages and restores name ordering", async () => {
  const description =
    "A research assistant for planning, documentation, review, and implementation. "
      .repeat(7)
      .slice(0, 512)
  const bots = Array.from({ length: 256 }, (_, index) =>
    Bot.make({ id: BotId.make(`agent-${index}`), name: `Agent ${index}`, description }),
  )
  const devices = Array.from({ length: 15 }, (_, index) =>
    Device.make({
      ...pageDevice(index + 1, `machine-${String(15 - index).padStart(2, "0")}`),
      bots,
    }),
  )
  const firstCursor = devices[13]?.id
  if (firstCursor === undefined) throw new Error("Missing first-page cursor")
  const first = DevicePage.make({ devices: devices.slice(0, 14), nextCursor: firstCursor })
  const second = DevicePage.make({ devices: devices.slice(14) })
  expect(Buffer.byteLength(JSON.stringify(devices))).toBeGreaterThan(2 * 1024 * 1024)
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(2 * 1024 * 1024)

  const paths: Array<string> = []
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input))
    paths.push(`${url.pathname}${url.search}`)
    if (url.pathname !== "/api/devices/page") throw new Error("Unexpected legacy request")
    return Response.json(url.searchParams.get("after") === null ? first : second)
  })
  try {
    const client = make({ baseUrl: "http://relay.test", token: "test" })
    const result = await Effect.runPromise(client.devices())
    expect(result.map((device) => device.name)).toEqual(
      Array.from({ length: 15 }, (_, index) => `machine-${String(index + 1).padStart(2, "0")}`),
    )
    expect(paths).toEqual(["/api/devices/page", `/api/devices/page?after=${firstCursor}`])
  } finally {
    fetch.mockRestore()
  }
})

it("falls back to the full legacy list only when the page route is missing", async () => {
  const devices = [pageDevice(1, "Zulu"), pageDevice(2, "Alpha")]
  const paths: Array<string> = []
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname
    paths.push(path)
    return path === "/api/devices/page"
      ? Response.json({ error: "Route not found" }, { status: 404 })
      : Response.json(devices)
  })
  try {
    const client = make({ baseUrl: "http://relay.test", token: "test" })
    expect(await Effect.runPromise(client.devices())).toEqual(devices)
    expect(paths).toEqual(["/api/devices/page", "/api/devices"])
  } finally {
    fetch.mockRestore()
  }
})

it("does not hide a page failure by requesting the legacy list", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json({ error: "Unavailable" }, { status: 500 }))
  try {
    const client = make({ baseUrl: "http://relay.test", token: "test" })
    await expect(Effect.runPromise(client.devices())).rejects.toMatchObject({ status: 500 })
    expect(fetch).toHaveBeenCalledTimes(1)
  } finally {
    fetch.mockRestore()
  }
})

it("rejects a page that repeats the previous cursor", async () => {
  const first = pageDevice(1, "Alpha")
  const second = pageDevice(2, "Beta")
  const pages = [
    DevicePage.make({ devices: [first], nextCursor: first.id }),
    DevicePage.make({ devices: [first, second], nextCursor: second.id }),
  ]
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json(pages.shift()))
  try {
    const client = make({ baseUrl: "http://relay.test", token: "test" })
    await expect(Effect.runPromise(client.devices())).rejects.toMatchObject({
      message: "Relay device page did not advance",
    })
  } finally {
    fetch.mockRestore()
  }
})

it("accepts an empty terminal page if devices disappear between requests", async () => {
  const first = pageDevice(1, "Alpha")
  const pages = [
    DevicePage.make({ devices: [first], nextCursor: first.id }),
    DevicePage.make({ devices: [] }),
  ]
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json(pages.shift()))
  try {
    const client = make({ baseUrl: "http://relay.test", token: "test" })
    expect(await Effect.runPromise(client.devices())).toEqual([first])
  } finally {
    fetch.mockRestore()
  }
})

it("rejects a later device page over its response limit", async () => {
  const first = pageDevice(1, "Alpha")
  const page = JSON.stringify(DevicePage.make({ devices: [] }))
  const oversized = `${page}${" ".repeat(maxDevicePageResponseBytes + 1 - Buffer.byteLength(page))}`
  const responses = [
    Response.json(DevicePage.make({ devices: [first], nextCursor: first.id })),
    new Response(oversized),
  ]
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const response = responses.shift()
    if (response === undefined) throw new Error("Unexpected page request")
    return response
  })
  try {
    const client = make({ baseUrl: "http://relay.test", token: "test" })
    await expect(Effect.runPromise(client.devices())).rejects.toMatchObject({
      message: "Relay response exceeded 3 MiB",
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  } finally {
    fetch.mockRestore()
  }
})

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
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) =>
      new URL(String(input)).pathname === "/api/devices/page"
        ? Response.json({ error: "Route not found" }, { status: 404 })
        : new Response(payload),
    )
  try {
    const client = make({ baseUrl: "http://relay.test", token: "test" })
    await expect(Effect.runPromise(client.devices())).rejects.toMatchObject({
      message: "Relay response exceeded 2 MiB",
    })
  } finally {
    fetch.mockRestore()
  }
})

it.each([
  { status: 200, operation: "getTask" },
  { status: 503, operation: "getTask" },
  { status: 200, operation: "exchangePairing" },
  { status: 503, operation: "exchangePairing" },
])(
  "closes a partial $status $operation response when its caller cancels",
  async ({ status, operation }) => {
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
      const baseUrl = `http://127.0.0.1:${address.port}`
      const running =
        operation === "getTask"
          ? Effect.runPromise(make({ baseUrl, token: "test" }).getTask(makeTaskId()), {
              signal: controller.signal,
            })
          : Effect.runPromise(exchangePairing(baseUrl, { token: "test" }), {
              signal: controller.signal,
            })
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
  },
)

it.each([
  {
    name: "a rejected pairing",
    status: 503,
    body: JSON.stringify({ error: "Pairing unavailable" }),
    error: {
      _tag: "RelayClient.RequestError",
      message: "Pairing unavailable",
      status: 503,
    },
  },
  {
    name: "an oversized pairing response",
    status: 200,
    body: " ".repeat(2 * 1024 * 1024 + 1),
    error: { _tag: "RelayClient.DecodeError", message: "Relay response exceeded 2 MiB" },
  },
])("preserves the error for $name", async ({ status, body, error }) => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status }))
  try {
    await expect(
      Effect.runPromise(exchangePairing("http://relay.test", { token: "test" })),
    ).rejects.toMatchObject({ operation: "RelayClient.exchangePairing", ...error })
  } finally {
    fetch.mockRestore()
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
