import { checkMcp } from "./mcp-diagnostics.ts"
import { execa } from "execa"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as z from "zod/v4"

const entrypoint = fileURLToPath(new URL("../../../bin/cohall.js", import.meta.url))
const relayUrl = "http://127.0.0.1:1"

describe("MCP doctor check", () => {
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
