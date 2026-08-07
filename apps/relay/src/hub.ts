import type { AuthSessionId, DeviceId, SocketEvent, Timestamp } from "@cohall/protocol"
import { WebSocket } from "ws"

export interface ConnectionData {
  processing: Promise<void>
  authDeadline: ReturnType<typeof setTimeout> | undefined
  preAuthFrameReceived: boolean
  queuedMessages: number
  closed: boolean
}

export type ConnectionSocket = WebSocket & { data: ConnectionData }

interface Principal {
  readonly sessionId?: AuthSessionId
  readonly boundDeviceId?: DeviceId
  readonly expiresAt?: Timestamp
}

export class Hub {
  readonly #principals = new Map<ConnectionSocket, Principal>()
  readonly #devices = new Map<DeviceId, ConnectionSocket>()
  readonly #deviceIds = new Map<ConnectionSocket, DeviceId>()

  attach(socket: ConnectionSocket, principal: Principal): void {
    this.#principals.set(socket, principal)
    if (socket.data.authDeadline !== undefined) {
      clearTimeout(socket.data.authDeadline)
      socket.data.authDeadline = undefined
    }
  }

  isAuthorized(socket: ConnectionSocket): boolean {
    const principal = this.#principals.get(socket)
    if (principal === undefined) {
      return false
    }
    if (principal.expiresAt !== undefined && Date.parse(principal.expiresAt) <= Date.now()) {
      socket.close(4003, "Session expired")
      return false
    }
    return true
  }

  boundDeviceId(socket: ConnectionSocket): DeviceId | undefined {
    return this.#principals.get(socket)?.boundDeviceId
  }

  registerDevice(deviceId: DeviceId, socket: ConnectionSocket): boolean {
    const previous = this.#devices.get(deviceId)
    if (previous !== undefined && previous !== socket && previous.readyState === WebSocket.OPEN) {
      return false
    }
    this.#devices.set(deviceId, socket)
    this.#deviceIds.set(socket, deviceId)
    return true
  }

  detach(socket: ConnectionSocket): DeviceId | undefined {
    if (socket.data.authDeadline !== undefined) {
      clearTimeout(socket.data.authDeadline)
    }
    this.#principals.delete(socket)
    const deviceId = this.#deviceIds.get(socket)
    this.#deviceIds.delete(socket)
    if (deviceId === undefined || this.#devices.get(deviceId) !== socket) {
      return undefined
    }
    this.#devices.delete(deviceId)
    return deviceId
  }

  deviceId(socket: ConnectionSocket): DeviceId | undefined {
    return this.#deviceIds.get(socket)
  }

  closeSession(sessionId: AuthSessionId): void {
    for (const [socket, principal] of this.#principals) {
      if (principal.sessionId === sessionId) {
        socket.close(4003, "Session revoked")
      }
    }
  }

  closeDevice(deviceId: DeviceId): void {
    this.#devices.get(deviceId)?.close(4003, "Device forgotten")
  }

  hasDevice(deviceId: DeviceId): boolean {
    return this.#devices.get(deviceId)?.readyState === WebSocket.OPEN
  }

  sendToDevice(deviceId: DeviceId, event: SocketEvent): boolean {
    const socket = this.#devices.get(deviceId)
    if (socket?.readyState !== WebSocket.OPEN || !this.isAuthorized(socket)) {
      return false
    }
    try {
      socket.send(JSON.stringify(event))
      return true
    } catch {
      return false
    }
  }
}
