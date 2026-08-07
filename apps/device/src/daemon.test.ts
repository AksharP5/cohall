import { DeviceId, SocketEvent, now } from "@cohall/protocol"
import { Effect } from "effect"
import { type AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { WebSocketServer } from "ws"
import { DeviceConfiguration } from "./config.ts"
import { runDaemon } from "./daemon.ts"

const servers: Array<WebSocketServer> = []
const controllers: Array<AbortController> = []

const startServer = async (): Promise<{
  readonly server: WebSocketServer
  readonly relayUrl: string
}> => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  servers.push(server)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const address = server.address() as AddressInfo
  return { server, relayUrl: `http://127.0.0.1:${address.port}` }
}

const run = (relayUrl: string): Promise<void> => {
  const controller = new AbortController()
  controllers.push(controller)
  const configuration = DeviceConfiguration.make({
    relayUrl,
    token: "device-token",
    id: DeviceId.make("11111111-1111-4111-8111-111111111111"),
    name: "test-device",
    workspaces: [process.cwd()],
  })
  return Effect.runPromise(runDaemon(configuration), { signal: controller.signal }).catch(() => {})
}

afterEach(async () => {
  for (const controller of controllers.splice(0)) {
    controller.abort()
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) {
            client.terminate()
          }
          server.close(() => resolve())
        }),
    ),
  )
})

describe("device relay connection", () => {
  it("closes a relay connection that outruns its message processor", async () => {
    const { server, relayUrl } = await startServer()
    const closed = new Promise<number>((resolve) => {
      server.once("connection", (socket) => {
        socket.once("message", () => {
          const connected = JSON.stringify(
            SocketEvent.make({ _tag: "Connected", serverVersion: "test", connectedAt: now() }),
          )
          for (let index = 0; index < 9; index += 1) {
            socket.send(connected)
          }
        })
        socket.once("close", resolve)
      })
    })

    void run(relayUrl)

    await expect(closed).resolves.toBe(4008)
  })

  it("rejects relay frames larger than 256 KiB", async () => {
    const { server, relayUrl } = await startServer()
    const closed = new Promise<number>((resolve) => {
      server.once("connection", (socket) => {
        socket.once("message", () => socket.send(Buffer.alloc(256 * 1024 + 1)))
        socket.once("close", resolve)
      })
    })

    void run(relayUrl)

    await expect(closed).resolves.toBe(1009)
  })
})
