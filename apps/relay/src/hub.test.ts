import { AuthSessionId, DeviceId, SocketEvent, makeTaskId } from "@cohall/protocol"
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

it("records dispatch only for live connections and before an uncertain send", () => {
  const hub = new Hub()
  const deviceId = DeviceId.make("22222222-2222-4222-8222-222222222222")
  const event = SocketEvent.make({ _tag: "CancelTask", taskId: makeTaskId() })
  const attempts: Array<string> = []
  const record = () => {
    attempts.push("record")
  }
  expect(hub.sendToDevice(deviceId, event, record)).toBe(false)
  expect(attempts).toEqual([])

  const connection = socket()
  connection.send = () => {
    attempts.push("send")
    throw new Error("Disconnected during send")
  }
  hub.attach(connection, {})
  hub.registerDevice(deviceId, connection)
  expect(hub.sendToDevice(deviceId, event, record)).toBe(false)
  expect(attempts).toEqual(["record", "send"])

  attempts.length = 0
  expect(() =>
    hub.sendToDevice(deviceId, event, () => {
      throw new Error("Persistence failed")
    }),
  ).toThrow("Persistence failed")
  expect(attempts).toEqual([])
})
