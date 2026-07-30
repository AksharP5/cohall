import type { DeviceId, SocketEvent } from "@cohall/protocol";

export interface ConnectionData {
  readonly role: "client" | "device";
}

export class Hub {
  readonly #clients = new Set<Bun.ServerWebSocket<ConnectionData>>();
  readonly #devices = new Map<DeviceId, Bun.ServerWebSocket<ConnectionData>>();
  readonly #deviceIds = new Map<Bun.ServerWebSocket<ConnectionData>, DeviceId>();

  attach(socket: Bun.ServerWebSocket<ConnectionData>): void {
    this.#clients.add(socket);
  }

  registerDevice(deviceId: DeviceId, socket: Bun.ServerWebSocket<ConnectionData>): void {
    const previous = this.#devices.get(deviceId);
    if (previous !== undefined && previous !== socket) {
      previous.close(4001, "Device reconnected");
    }
    this.#devices.set(deviceId, socket);
    this.#deviceIds.set(socket, deviceId);
  }

  detach(socket: Bun.ServerWebSocket<ConnectionData>): DeviceId | undefined {
    this.#clients.delete(socket);
    const deviceId = this.#deviceIds.get(socket);
    if (deviceId === undefined) {
      return undefined;
    }
    this.#deviceIds.delete(socket);
    if (this.#devices.get(deviceId) === socket) {
      this.#devices.delete(deviceId);
    }
    return deviceId;
  }

  deviceId(socket: Bun.ServerWebSocket<ConnectionData>): DeviceId | undefined {
    return this.#deviceIds.get(socket);
  }

  hasDevice(deviceId: DeviceId): boolean {
    return this.#devices.has(deviceId);
  }

  sendToDevice(deviceId: DeviceId, event: SocketEvent): boolean {
    const socket = this.#devices.get(deviceId);
    if (socket === undefined) {
      return false;
    }
    socket.send(JSON.stringify(event));
    return true;
  }

  broadcast(event: SocketEvent): void {
    const payload = JSON.stringify(event);
    for (const socket of this.#clients) {
      socket.send(payload);
    }
  }
}
