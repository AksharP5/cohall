import { checkMcp } from "./mcp-diagnostics.ts"
import { execa } from "execa"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import * as z from "zod/v4"

const entrypoint = fileURLToPath(new URL("../../../bin/cohall.js", import.meta.url))
const relayUrl = "http://127.0.0.1:1"

describe("MCP doctor check", () => {
  it.each([
    { name: "default automatic selection", providers: undefined, gateway: true, warning: true },
    { name: "explicit automatic selection", providers: "auto", gateway: true, warning: true },
    { name: "explicit Grok selection", providers: "grok-bot", gateway: true, warning: true },
    { name: "explicit coding selection", providers: "codex", gateway: true, warning: false },
    {
      name: "automatic selection without a gateway",
      providers: "auto",
      gateway: false,
      warning: false,
    },
  ])("checks an unavailable gateway with $name", async ({ providers, gateway, warning }) => {
    const { stdout } = await execa(process.execPath, [entrypoint, "doctor"], {
      env: {
        ...process.env,
        COHALL_CONFIG: join(tmpdir(), `cohall-doctor-${randomUUID()}.json`),
        COHALL_CLIENT_TOKEN: undefined,
        COHALL_DEVICE_TOKEN: undefined,
        COHALL_RELAY_URL: relayUrl,
        COHALL_DEVICE_PROVIDERS: providers,
        COHALL_GROK_GATEWAY: gateway
          ? join(tmpdir(), `missing-grok-gateway-${randomUUID()}.json`)
          : undefined,
      },
    })
    const report = z.object({ warnings: z.array(z.string()) }).parse(JSON.parse(stdout))
    const gatewayWarning =
      "Configured Grok Bot gateway is unavailable; check its discovery file and host process"

    expect(report.warnings.includes(gatewayWarning)).toBe(warning)
  })

  it.each([
    { name: "valid client", status: 200, deviceCredential: false },
    { name: "rejected client", status: 401, deviceCredential: false },
    { name: "rejected client on a device", status: 401, deviceCredential: true },
    { name: "relay failure", status: 503, deviceCredential: true },
  ])("reports relay authentication for a $name", async ({ status, deviceCredential }) => {
    const authorizations: Array<string | undefined> = []
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json")
      if (request.url === "/api/health") {
        response.end(JSON.stringify({ ok: true }))
        return
      }
      if (request.url === "/api/devices") {
        authorizations.push(request.headers.authorization)
        response
          .writeHead(status)
          .end(
            JSON.stringify(
              status === 200
                ? []
                : { error: status === 401 ? "Unauthorized" : "Relay maintenance" },
            ),
          )
        return
      }
      response.writeHead(404).end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address()
      if (address === null || typeof address === "string") throw new Error("Missing test port")
      const { stdout } = await execa(process.execPath, [entrypoint, "doctor"], {
        env: {
          ...process.env,
          COHALL_CONFIG: join(tmpdir(), `cohall-doctor-${randomUUID()}.json`),
          COHALL_CLIENT_TOKEN: "test-token",
          COHALL_RELAY_URL: `http://127.0.0.1:${address.port}`,
          COHALL_DEVICE_TOKEN: deviceCredential ? "device-test-token" : undefined,
          COHALL_DEVICE_ID: deviceCredential ? "11111111-1111-4111-8111-111111111111" : undefined,
          COHALL_DEVICE_PROVIDERS: "auto",
          COHALL_GROK_GATEWAY: undefined,
        },
      })
      const report = z
        .object({
          relay: z.literal("reachable"),
          client_authentication: z.object({
            status: z.enum(["ok", "error"]),
            http_status: z.number().optional(),
            error: z.string().optional(),
          }),
          mcp: z.object({ status: z.literal("ok") }),
          warnings: z.array(z.string()),
        })
        .parse(JSON.parse(stdout))

      expect(authorizations).toEqual(["Bearer test-token"])
      if (status === 200) {
        expect(report.client_authentication).toEqual({ status: "ok" })
        expect(report.warnings).toEqual([])
        return
      }
      expect(report.client_authentication).toMatchObject({ status: "error", http_status: status })
      expect(report.warnings).toEqual([report.client_authentication.error])
      expect(report.client_authentication.error).toContain(
        status === 401 ? "Client credential was rejected" : "Client relay check failed",
      )
      expect(report.client_authentication.error).toContain(
        status === 401 ? "Unauthorized" : "Relay maintenance",
      )
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      )
    }
  })

  it("lists packaged tools through a self-test without claiming a host connection", async () => {
    const { stdout } = await execa(process.execPath, [entrypoint, "doctor"], {
      env: {
        ...process.env,
        COHALL_CONFIG: join(tmpdir(), `cohall-doctor-${randomUUID()}.json`),
        COHALL_CLIENT_TOKEN: "test-token",
        COHALL_RELAY_URL: relayUrl,
      },
    })
    const report = z
      .object({
        mcp: z.object({
          status: z.literal("ok"),
          scope: z.literal("server self-test"),
          tool_count: z.number().positive(),
        }),
        mcp_host: z.object({
          status: z.literal("not_observed"),
          sessions: z.array(z.unknown()).length(0),
        }),
      })
      .parse(JSON.parse(stdout))

    expect(report.mcp.tool_count).toBeGreaterThan(0)
  })

  it("reports a server that cannot start", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cohall-doctor-failure-"))
    vi.stubEnv("COHALL_CONFIG", join(directory, "config.json"))
    try {
      const result = await checkMcp(join(directory, "missing.js"), relayUrl, "test-token")
      expect(result.status).toBe("error")
    } finally {
      vi.unstubAllEnvs()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
