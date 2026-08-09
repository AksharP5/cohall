import { AuthSessionId, DeviceId } from "@cohall/protocol"
import { expect, it } from "vitest"
import { WebSocket } from "ws"
import { Hub, type ConnectionSocket } from "./hub.ts"

const socket = (): ConnectionSocket =>
  ({
    readyState: WebSocket.OPEN,
    data: {
      processing: Promise.resolve(),
      stageDeadline: undefined,
      preAuthFrameReceived: false,
      queuedMessages: 0,
      closed: false,
    },
  }) as unknown as ConnectionSocket

it("permits only one socket per device session", () => {
  const hub = new Hub()
  const sessionId = AuthSessionId.make("11111111-1111-4111-8111-111111111111")
  const first = socket()
  const second = socket()
  expect(hub.attach(first, { sessionId })).toBe(true)
  expect(hub.attach(second, { sessionId })).toBe(false)
  hub.detach(first)
  expect(hub.attach(second, { sessionId })).toBe(true)
})

it("bounds owner sockets and accepts one registration per socket", () => {
  const hub = new Hub()
  const owners = Array.from({ length: 17 }, socket)
  expect(owners.slice(0, 16).every((connection) => hub.attach(connection, {}))).toBe(true)
  const first = owners[0]
  const overflow = owners[16]
  if (first === undefined || overflow === undefined) {
    throw new Error("Expected owner socket fixtures")
  }
  expect(hub.attach(overflow, {})).toBe(false)

  const deviceId = DeviceId.make("22222222-2222-4222-8222-222222222222")
  expect(hub.pendingConnections()).toBe(16)
  expect(hub.registerDevice(deviceId, first)).toBe(true)
  expect(hub.registerDevice(deviceId, first)).toBe(false)
  expect(hub.pendingConnections()).toBe(15)
})
