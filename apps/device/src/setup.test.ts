import { DeviceId } from "@cohall/protocol"
import { createServer, type Server } from "node:http"
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { StoredConfiguration, makeStoredConfiguration, writeStoredConfiguration } from "./config.ts"
import { guidedSetupInput, joinRelay, type Prompter } from "./setup.ts"

const directories: Array<string> = []
const servers: Array<Server> = []
const previousConfig = process.env.COHALL_CONFIG

const temporary = async (): Promise<string> => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cohall-setup-")))
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
  it.each([false, true])(
    "rejects an invalid device name before collecting credentials with token reader=%s",
    async (withTokenReader) => {
      const workspace = await temporary()
      const secret = vi.fn<Prompter["secret"]>().mockResolvedValue("pairing-secret")
      const readToken = vi.fn<() => Promise<string>>().mockResolvedValue("pairing-secret")
      await expect(
        guidedSetupInput(
          {
            relayUrl: "https://relay.example",
            clientOnly: false,
            workspaces: [workspace],
            cwd: workspace,
            ...(withTokenReader ? { readToken, deviceName: "n".repeat(129) } : {}),
          },
          { ...prompter({ "Device name": "n".repeat(129) }), secret },
        ),
      ).rejects.toThrow("128")
      expect(secret).not.toHaveBeenCalled()
      expect(readToken).not.toHaveBeenCalled()
    },
  )

  it("requires a relay address before collecting first-run credentials", async () => {
    const workspace = await temporary()
    const secret = vi.fn<Prompter["secret"]>().mockResolvedValue("pairing-secret")
    await expect(
      guidedSetupInput(
        { clientOnly: false, workspaces: [], cwd: workspace },
        { ...prompter({}), secret },
      ),
    ).rejects.toThrow("Relay URL is required")
    expect(secret).not.toHaveBeenCalled()
  })

  it("rejects a prompted provider selection before collecting credentials", async () => {
    const workspace = await temporary()
    const secret = vi.fn<Prompter["secret"]>().mockResolvedValue("pairing-secret")
    await expect(
      guidedSetupInput(
        { clientOnly: false, workspaces: [], cwd: workspace },
        {
          ...prompter({ "Relay URL": "https://relay.example", Providers: "not-a-provider" }),
          secret,
        },
      ),
    ).rejects.toThrow("not-a-provider")
    expect(secret).not.toHaveBeenCalled()
  })

  it.each(["defaults", "prompt", "explicit"] as const)(
    "retains existing workspace roots unless replaced through %s",
    async (mode) => {
      const workspace = await temporary()
      const second = join(workspace, "second,root")
      const replacement = join(workspace, "replacement")
      await Promise.all([mkdir(second), mkdir(replacement)])
      await writeStoredConfiguration(
        StoredConfiguration.make({
          version: 1,
          relayUrl: "https://relay.example",
          deviceId: DeviceId.make("11111111-1111-4111-8111-111111111111"),
          deviceName: "workstation",
          workspaces: [workspace, second],
          clientToken: "client-secret",
          deviceToken: "device-secret",
        }),
      )
      const input = await guidedSetupInput(
        {
          clientOnly: false,
          workspaces: mode === "explicit" ? [replacement] : [],
          cwd: workspace,
        },
        prompter(mode === "prompt" ? { "Workspace root": replacement } : {}),
      )
      expect(input.reusedConfiguration).toBe(true)
      const configuration = await makeStoredConfiguration({
        relayUrl: input.relayUrl,
        workspaces: input.workspaces,
      })
      expect(configuration.workspaces).toEqual(
        mode === "defaults" ? [workspace, second] : [replacement],
      )
    },
  )

  it.each([
    { override: undefined, expected: ["claude-code"] },
    { override: "codex", expected: ["codex"] },
    { override: "auto", expected: undefined },
  ])(
    "preserves client-only provider selection unless overridden with $override",
    async ({ override, expected }) => {
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
          providers: ["claude-code"],
        }),
      )
      const input = await guidedSetupInput(
        {
          clientOnly: true,
          workspaces: [],
          cwd: workspace,
          ...(override === undefined ? {} : { providers: override }),
        },
        prompter({}),
      )
      expect(input.reusedConfiguration).toBe(true)
      const configuration = await makeStoredConfiguration({
        relayUrl: input.relayUrl,
        workspaces: input.workspaces,
        providers: input.providers,
      })
      expect(configuration.providers).toEqual(expected)
      expect(configuration).toMatchObject({
        deviceName: "workstation",
        workspaces: [workspace],
        clientToken: "client-secret",
        deviceToken: "device-secret",
      })
    },
  )

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
      providers: ["codex", "opencode"],
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

it("rejects an invalid device name before exchanging credentials or replacing configuration", async () => {
  const workspace = await temporary()
  const configuration = await makeStoredConfiguration({
    relayUrl: "https://relay.example",
    deviceName: "workstation",
    workspaces: [workspace],
    clientToken: "existing-client-token",
    deviceToken: "existing-device-token",
  })
  await writeStoredConfiguration(configuration)
  const path = join(workspace, "config.json")
  const saved = await readFile(path, "utf8")
  const exchange = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected exchange"))
  try {
    await expect(
      joinRelay({
        relayUrl: configuration.relayUrl,
        token: "pairing-secret",
        clientOnly: false,
        deviceName: "n".repeat(129),
        workspaces: [workspace],
      }),
    ).rejects.toThrow("128")
    expect(exchange).not.toHaveBeenCalled()
    expect(await readFile(path, "utf8")).toBe(saved)
  } finally {
    exchange.mockRestore()
  }
})

it("joins with a 128-character device name and stores both scoped credentials", async () => {
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
    deviceName: "n".repeat(128),
    workspaces: [workspace],
    providers: ["codex"],
  })

  expect(result.roles).toEqual(["client", "device"])
  expect(result.configuration).toMatchObject({
    deviceId,
    deviceName: "n".repeat(128),
    clientToken: "client-secret",
    deviceToken: "device-secret",
  })
})
