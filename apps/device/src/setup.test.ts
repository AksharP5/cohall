import { DeviceId } from "@cohall/protocol"
import { createServer, type Server } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { StoredConfiguration, writeStoredConfiguration } from "./config.ts"
import { guidedSetupInput, joinRelay, type Prompter } from "./setup.ts"

const directories: Array<string> = []
const servers: Array<Server> = []
const previousConfig = process.env.COHALL_CONFIG

const temporary = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-setup-"))
  directories.push(directory)
  process.env.COHALL_CONFIG = join(directory, "config.json")
  return directory
}

afterEach(async () => {
  if (previousConfig === undefined) {
    delete process.env.COHALL_CONFIG
  } else {
    process.env.COHALL_CONFIG = previousConfig
  }
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })))
})

const prompter = (
  answers: Readonly<Record<string, string>>,
  secret = "pairing-secret",
): Prompter => ({
  answer: (label, fallback) => Promise.resolve(answers[label] ?? fallback),
  secret: () => Promise.resolve(secret),
  close: () => undefined,
})

describe("guided setup", () => {
  it("turns a first run into complete join input", async () => {
    const workspace = await temporary()
    const input = await guidedSetupInput(
      { clientOnly: false, workspaces: [], cwd: workspace },
      prompter({
        "Relay URL": "https://relay.example",
        "Workspace root": workspace,
        "Device name": "workstation",
        Providers: "codex,opencode",
      }),
    )

    expect(input).toEqual({
      relayUrl: "https://relay.example",
      token: "pairing-secret",
      deviceName: "workstation",
      workspaces: [workspace],
      providers: "codex,opencode",
      reusedConfiguration: false,
    })
  })

  it("reuses credentials already issued by the selected relay", async () => {
    const workspace = await temporary()
    await writeStoredConfiguration(
      StoredConfiguration.make({
        version: 1,
        relayUrl: "https://relay.example",
        deviceId: DeviceId.make("11111111-1111-4111-8111-111111111111"),
        deviceName: "workstation",
        workspaces: [workspace],
        clientToken: "client-secret",
        deviceToken: "device-secret",
      }),
    )
    const input = await guidedSetupInput(
      {
        relayUrl: "https://relay.example",
        clientOnly: false,
        deviceName: "workstation",
        workspaces: [workspace],
        providers: "auto",
        cwd: workspace,
      },
      {
        answer: (_label, fallback) => Promise.resolve(fallback),
        secret: () => Promise.reject(new Error("secret prompt should not run")),
        close: () => undefined,
      },
    )

    expect(input.reusedConfiguration).toBe(true)
    expect(input.token).toBeUndefined()
  })
})

it("joins once and stores both scoped credentials", async () => {
  const workspace = await temporary()
  const deviceId = "22222222-2222-4222-8222-222222222222"
  const timestamp = "2026-08-09T12:00:00.000Z"
  const server = createServer((request, response) => {
    expect(request.url).toBe("/api/auth/pair")
    response.writeHead(200, { "content-type": "application/json" })
    response.end(
      JSON.stringify({
        credentials: [
          {
            token: "client-secret",
            session: {
              id: "33333333-3333-4333-8333-333333333333",
              label: "Workstation client",
              role: "client",
              createdAt: timestamp,
              expiresAt: timestamp,
              lastSeenAt: timestamp,
            },
          },
          {
            token: "device-secret",
            session: {
              id: "44444444-4444-4444-8444-444444444444",
              label: "Workstation device",
              role: "device",
              createdAt: timestamp,
              expiresAt: timestamp,
              lastSeenAt: timestamp,
              deviceId,
            },
          },
        ],
      }),
    )
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not expose a TCP address")
  }

  const result = await joinRelay({
    relayUrl: `http://127.0.0.1:${address.port}`,
    token: "pairing-secret",
    clientOnly: false,
    deviceName: "workstation",
    workspaces: [workspace],
    providers: ["codex"],
  })

  expect(result.roles).toEqual(["client", "device"])
  expect(result.configuration).toMatchObject({
    deviceId,
    clientToken: "client-secret",
    deviceToken: "device-secret",
  })
})
