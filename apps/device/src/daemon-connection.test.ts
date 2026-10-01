import { DeviceId, now } from "@cohall/protocol"
import { Effect } from "effect"
import { createServer } from "node:http"
import type { Duplex } from "node:stream"
import { afterEach, expect, it, vi } from "vitest"
import { WebSocket, WebSocketServer } from "ws"
import { DeviceConfiguration } from "./config.ts"
import { runDaemon } from "./daemon.ts"

const realSetTimeout = setTimeout
const realClearTimeout = clearTimeout
const cleanups: Array<() => Promise<void>> = []

const waitFor = async <A>(promise: Promise<A>): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = realSetTimeout(() => reject(new Error("Timed out waiting for socket event")), 2_000)
      }),
    ])
  } finally {
    realClearTimeout(timer)
  }
}

const startRelay = async (stall?: "upgrade" | "authentication") => {
  const server = createServer()
  const websocketServer = new WebSocketServer({ noServer: true })
  const sockets = new Set<Duplex>()
  const firstAttempt = Promise.withResolvers<void>()
  const firstAuthentication = Promise.withResolvers<void>()
  const firstClosed = Promise.withResolvers<void>()
  const firstConnected = Promise.withResolvers<WebSocket>()
  const reconnected = Promise.withResolvers<void>()
  const controller = new AbortController()
  let attempts = 0
  let daemon: Promise<void> | undefined
  cleanups.push(async () => {
    controller.abort()
    for (const socket of websocketServer.clients) socket.terminate()
    for (const socket of sockets) socket.destroy()
    await daemon
    await Promise.all([
      new Promise<void>((resolve) => websocketServer.close(() => resolve())),
      new Promise<void>((resolve) => server.close(() => resolve())),
    ])
  })
  server.on("upgrade", (request, socket, head) => {
    attempts += 1
    sockets.add(socket)
    socket.on("error", () => {})
    socket.once("close", () => sockets.delete(socket))
    if (attempts === 1) {
      firstAttempt.resolve()
      socket.once("close", () => firstClosed.resolve())
      if (stall === "upgrade") {
        socket.once("end", () => socket.destroy())
        socket.resume()
        return
      }
    }
    websocketServer.handleUpgrade(request, socket, head, (connection) => {
      const first = attempts === 1
      connection.on("message", (raw) => {
        const event: unknown = JSON.parse(raw.toString())
        if (typeof event !== "object" || event === null || !("_tag" in event)) return
        if (event._tag === "Authenticate") {
          if (first) firstAuthentication.resolve()
          if (first && stall === "authentication") return
          connection.send(
            JSON.stringify({ _tag: "Connected", serverVersion: "test", connectedAt: now() }),
          )
        }
        if (event._tag === "DeviceHello") {
          if (first) firstConnected.resolve(connection)
          else reconnected.resolve()
        }
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("Missing relay address")
  daemon = Effect.runPromise(
    runDaemon(
      DeviceConfiguration.make({
        relayUrl: `http://127.0.0.1:${address.port}`,
        token: "device-token",
        id: DeviceId.make("11111111-1111-4111-8111-111111111111"),
        name: "test-device",
        workspaces: [process.cwd()],
      }),
    ),
    { signal: controller.signal },
  ).catch(() => {})
  await waitFor(firstAttempt.promise)
  return {
    websocketServer,
    firstAuthentication: firstAuthentication.promise,
    firstClosed: firstClosed.promise,
    firstConnected: firstConnected.promise,
    reconnected: reconnected.promise,
    attempts: () => attempts,
    stop: async () => {
      controller.abort()
      await daemon
    },
  }
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  vi.useRealTimers()
})

it.each(["upgrade", "authentication"] as const)(
  "retries a stalled %s without waiting for the peer to close",
  async (phase) => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    })
    const relay = await startRelay(phase)
    if (phase === "authentication") {
      await waitFor(relay.firstAuthentication)
      const socket = relay.websocketServer.clients.values().next().value
      if (socket === undefined) throw new Error("Missing authenticated socket")
      const pong = new Promise<void>((resolve) => socket.once("pong", () => resolve()))
      socket.ping()
      await waitFor(pong)
    }
    await vi.advanceTimersByTimeAsync(10_000)
    await waitFor(relay.firstClosed)
    await new Promise<void>((resolve) => setImmediate(resolve))
    await vi.advanceTimersByTimeAsync(2_000)
    await waitFor(relay.reconnected)
    expect(relay.attempts()).toBe(2)
  },
)

it("reconnects when an accepted relay connection stops sending pings", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  })
  const relay = await startRelay()
  await waitFor(relay.firstConnected)
  await vi.advanceTimersByTimeAsync(45_000)
  await waitFor(relay.firstClosed)
  await new Promise<void>((resolve) => setImmediate(resolve))
  await vi.advanceTimersByTimeAsync(2_000)
  await waitFor(relay.reconnected)
  expect(relay.attempts()).toBe(2)
})

it("keeps a healthy connection open and clears its watchdog on shutdown", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  })
  const relay = await startRelay()
  const socket = await waitFor(relay.firstConnected)
  for (let interval = 0; interval < 3; interval += 1) {
    await vi.advanceTimersByTimeAsync(30_000)
    const pong = new Promise<void>((resolve) => socket.once("pong", () => resolve()))
    socket.ping()
    await waitFor(pong)
    expect(socket.readyState).toBe(WebSocket.OPEN)
    expect(relay.attempts()).toBe(1)
  }
  await relay.stop()
  await waitFor(relay.firstClosed)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(relay.attempts()).toBe(1)
  expect(vi.getTimerCount()).toBe(0)
})
