import { checkMcp } from "./mcp-diagnostics.ts"
import { execa } from "execa"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as z from "zod/v4"

const entrypoint = fileURLToPath(new URL("../../../bin/cohall.js", import.meta.url))
const relayUrl = "http://127.0.0.1:1"

describe("MCP doctor check", () => {
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

  it("starts the packaged server and lists its tools", async () => {
    const { stdout } = await execa(process.execPath, [entrypoint, "doctor"], {
      env: {
        ...process.env,
        COHALL_CONFIG: join(tmpdir(), `cohall-doctor-${randomUUID()}.json`),
        COHALL_CLIENT_TOKEN: "test-token",
        COHALL_RELAY_URL: relayUrl,
      },
    })
    const report = z
      .object({ mcp: z.object({ status: z.literal("ok"), tool_count: z.number().positive() }) })
      .parse(JSON.parse(stdout))

    expect(report.mcp.tool_count).toBeGreaterThan(0)
  })

  it("reports a server that cannot start", async () => {
    const result = await checkMcp(
      join(tmpdir(), `missing-cohall-${randomUUID()}.js`),
      relayUrl,
      "test-token",
    )

    expect(result.status).toBe("error")
  })
})
