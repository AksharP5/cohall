import type { AuthSessionId, DeviceId, SocketEvent } from "@cohall/protocol"

export interface ConnectionData {
  readonly role: "client" | "device"
}

export class Hub {
  readonly #clients = new Set<Bun.ServerWebSocket<ConnectionData>>()
  readonly #authenticated = new Set<Bun.ServerWebSocket<ConnectionData>>()
  readonly #devices = new Map<DeviceId, Bun.ServerWebSocket<ConnectionData>>()
  readonly #deviceIds = new Map<Bun.ServerWebSocket<ConnectionData>, DeviceId>()
  readonly #sessionIds = new Map<Bun.ServerWebSocket<ConnectionData>, AuthSessionId>()
  readonly #boundDeviceIds = new Map<Bun.ServerWebSocket<ConnectionData>, DeviceId>()

  attach(
    socket: Bun.ServerWebSocket<ConnectionData>,
    sessionId?: AuthSessionId,
    boundDeviceId?: DeviceId,
  ): void {
    this.#authenticated.add(socket)
    if (socket.data.role === "client") {
      this.#clients.add(socket)
    }
    if (sessionId !== undefined) {
      this.#sessionIds.set(socket, sessionId)
    }
    if (boundDeviceId !== undefined) {
      this.#boundDeviceIds.set(socket, boundDeviceId)
    }
  }

  isAttached(socket: Bun.ServerWebSocket<ConnectionData>): boolean {
    return this.#authenticated.has(socket)
  }

  registerDevice(deviceId: DeviceId, socket: Bun.ServerWebSocket<ConnectionData>): void {
    const previous = this.#devices.get(deviceId)
    this.#devices.set(deviceId, socket)
    this.#deviceIds.set(socket, deviceId)
    if (previous !== undefined && previous !== socket) {
      previous.close(4001, "Device reconnected")
    }
  }

  detach(socket: Bun.ServerWebSocket<ConnectionData>): DeviceId | undefined {
    this.#authenticated.delete(socket)
    this.#clients.delete(socket)
    this.#sessionIds.delete(socket)
    this.#boundDeviceIds.delete(socket)
    const deviceId = this.#deviceIds.get(socket)
    if (deviceId === undefined) {
      return undefined
    }
    this.#deviceIds.delete(socket)
    if (this.#devices.get(deviceId) !== socket) {
      return undefined
    }
    this.#devices.delete(deviceId)
    return deviceId
  }

  deviceId(socket: Bun.ServerWebSocket<ConnectionData>): DeviceId | undefined {
    return this.#deviceIds.get(socket)
  }

  boundDeviceId(socket: Bun.ServerWebSocket<ConnectionData>): DeviceId | undefined {
    return this.#boundDeviceIds.get(socket)
  }

  closeSession(sessionId: AuthSessionId): void {
    for (const [socket, current] of this.#sessionIds) {
      if (current === sessionId) {
        socket.close(4003, "Session revoked")
      }
    }
  }

  hasDevice(deviceId: DeviceId): boolean {
    return this.#devices.has(deviceId)
  }

  sendToDevice(deviceId: DeviceId, event: SocketEvent): boolean {
    const socket = this.#devices.get(deviceId)
    if (socket === undefined) {
      return false
    }
    socket.send(JSON.stringify(event))
    return true
  }

  broadcast(event: SocketEvent): void {
    const payload = JSON.stringify(event)
    for (const socket of this.#clients) {
      socket.send(payload)
    }
  }
}
