import { RelayClient, RelayDecodeError, RelayRequestError } from "@cohall/client"
import { DeviceOverview, makeDeviceId, Timestamp } from "@cohall/protocol"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { createServer } from "node:http"
import { expect, it, vi } from "vitest"
import { renderDeviceWatch, watchDevices, type DeviceWatchUpdate } from "./device-watch.ts"

const time = Date.parse("2026-10-08T00:10:00Z")
const device = DeviceOverview.make({
  id: makeDeviceId(),
  name: "healthy worker",
  status: "online",
  version: "0.12.0",
  lastSeenAt: Timestamp.make("2026-10-08T00:09:00Z"),
  queued: 0,
  active: 0,
  needsInput: 0,
  cancelling: 0,
})

it("puts stranded work and unanswered questions first and escapes terminal control characters", () => {
  const devices = [
    device,
    { ...device, name: "old version", version: "0.11.3" },
    { ...device, name: "needs an answer", needsInput: 1 },
    {
      ...device,
      name: "offline queue",
      status: "offline" as const,
      queued: 2,
      oldestQueuedAt: Timestamp.make("2026-10-08T00:00:00Z"),
      description: "iOS\u001b[2J\nworker",
    },
  ]
  const output = renderDeviceWatch({ devices, updatedAt: time }, "0.12.0")
  expect(output.indexOf("offline queue")).toBeLessThan(output.indexOf("needs an answer"))
  expect(output.indexOf("needs an answer")).toBeLessThan(output.indexOf("old version"))
  expect(output.indexOf("old version")).toBeLessThan(output.indexOf("healthy worker"))
  expect(output).toContain("10m")
  expect(output).toContain("*0.11.3")
  expect(output).not.toContain("\u001b")
  expect(output).toContain("iOS [2J worker")
  expect(renderDeviceWatch({ devices: [], updatedAt: time }, "0.12.0")).toContain(
    "No devices are registered",
  )
})

it("refreshes on its cadence, recovers from a network error, and stops when interrupted", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let calls = 0
      const updates: Array<DeviceWatchUpdate> = []
      const client = {
        deviceOverview: () =>
          Effect.suspend(() => {
            calls++
            return calls === 2
              ? Effect.fail(new RelayRequestError({ operation: "test", message: "Disconnected" }))
              : Effect.succeed([device])
          }),
      }
      const fiber = yield* watchDevices(client, 5, (update) => updates.push(update)).pipe(
        Effect.forkChild,
      )
      yield* TestClock.adjust("0 seconds")
      expect(calls).toBe(1)
      yield* TestClock.adjust("4 seconds")
      expect(calls).toBe(1)
      yield* TestClock.adjust("1 second")
      expect(updates[1]).toEqual({ error: "Disconnected" })
      yield* TestClock.adjust("5 seconds")
      expect(updates[2]).toMatchObject({ devices: [device] })
      yield* Fiber.interrupt(fiber)
      yield* TestClock.adjust("10 seconds")
      expect(calls).toBe(3)
    }).pipe(Effect.provide(TestClock.layer())),
  )
})

it("keeps identically named devices distinguishable", () => {
  const devices = [
    { ...device, id: makeDeviceId(), name: "production mac for iOS builds" },
    { ...device, id: makeDeviceId(), name: "production mac for iOS builds" },
  ]
  const output = renderDeviceWatch({ devices, updatedAt: time }, "0.12.0")
  for (const target of devices) expect(output).toContain(target.id.slice(0, 8))
})

it("refreshes again after the relay connection closes during a response body", async () => {
  let requests = 0
  let disconnect: (() => void) | undefined
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json")
    if (++requests === 1) {
      response.write("[")
      disconnect = () => response.destroy()
      return
    }
    response.end(JSON.stringify([device]))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const originalFetch = globalThis.fetch
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (...arguments_) => {
    const response = await originalFetch(...arguments_)
    // Close only after the client receives headers, so this exercises body reading.
    disconnect?.()
    disconnect = undefined
    return response
  })
  const controller = new AbortController()
  const updates: Array<DeviceWatchUpdate> = []
  try {
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("Missing test port")
    const client = RelayClient.make({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "test",
    })
    await Effect.runPromise(
      watchDevices(client, 0.01, (update) => {
        updates.push(update)
        if ("devices" in update) controller.abort()
      }).pipe(Effect.timeout("2 seconds")),
      { signal: controller.signal },
    ).catch(() => undefined)
    expect(updates).toEqual([
      { error: expect.stringContaining("terminated") },
      { devices: [device], updatedAt: expect.any(Number) },
    ])
    expect(requests).toBe(2)
  } finally {
    controller.abort()
    fetch.mockRestore()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it.each([
  new RelayRequestError({ operation: "test", message: "Unauthorized", status: 401 }),
  new RelayRequestError({ operation: "test", message: "Update relay", status: 404 }),
  new RelayDecodeError({ operation: "test", message: "Invalid response" }),
])("reports a permanent failure and stops instead of repeatedly requesting it", async (error) => {
  const updates: Array<DeviceWatchUpdate> = []
  await expect(
    Effect.runPromise(
      watchDevices({ deviceOverview: () => Effect.fail(error) }, 5, (update) =>
        updates.push(update),
      ),
    ),
  ).rejects.toThrow(error.message)
  expect(updates).toEqual([{ error: error.message }])
})
