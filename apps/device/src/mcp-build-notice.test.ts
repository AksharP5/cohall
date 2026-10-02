import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { copyFile, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as z from "zod/v4"
import { createMcpBuildNotice } from "./mcp-build-notice.ts"

const result: CallToolResult = {
  content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
  structuredContent: { task: "completed" },
  isError: false,
  _meta: { source: "test" },
}

describe("MCP build notices", () => {
  it("checks periodically and reports each replaced version once without changing the result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cohall-mcp-build-"))
    const entrypoint = join(directory, "cohall.mjs")
    let now = 0
    const replace = async (version: string) => {
      await writeFile(join(directory, "replacement.mjs"), `console.log(${JSON.stringify(version)})`)
      await rename(join(directory, "replacement.mjs"), entrypoint)
    }
    try {
      await replace("0.8.0")
      const notice = await createMcpBuildNotice(entrypoint, "0.8.0", { now: () => now })
      expect(await notice(result)).toBe(result)

      await replace("0.9.0")
      expect(await notice(result)).toBe(result)
      now = 60_000
      const warned = await notice(result)
      expect(warned).toEqual({
        ...result,
        content: [...result.content, { type: "text", text: expect.stringContaining("now 0.9.0") }],
      })
      expect(warned.content[1]).toMatchObject({ text: expect.stringContaining("Restart") })
      now += 60_000
      expect(await notice(result)).toBe(result)

      await replace("0.10.0-rc.1")
      now += 60_000
      expect((await notice(result)).content[1]).toMatchObject({
        text: expect.stringContaining("now 0.10.0-rc.1"),
      })
      await replace("0.9.0")
      now += 60_000
      expect(await notice(result)).toBe(result)
      await replace("0.8.0")
      now += 60_000
      expect(await notice(result)).toBe(result)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("retries a timed out version probe and leaves concurrent calls usable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cohall-mcp-build-"))
    const entrypoint = join(directory, "cohall.mjs")
    let now = 0
    try {
      await writeFile(entrypoint, 'console.log("0.8.0")')
      const notice = await createMcpBuildNotice(entrypoint, "0.8.0", {
        now: () => now,
        probeTimeoutMs: 300,
      })
      await writeFile(
        entrypoint,
        `import { existsSync } from "node:fs"
if (existsSync(new URL("ready", import.meta.url))) console.log("0.9.0")
else setInterval(() => {}, 1000)`,
      )
      const results = await Promise.all([notice(result), notice(result)])
      expect(results).toEqual([result, result])
      await writeFile(join(directory, "ready"), "")
      now = 60_000
      expect((await notice(result)).content[1]).toMatchObject({
        text: expect.stringContaining("now 0.9.0"),
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === "win32")("detects replacement of a launched symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cohall-mcp-build-"))
    const entrypoint = join(directory, "cohall.mjs")
    try {
      await writeFile(join(directory, "old.mjs"), 'console.log("0.8.0")')
      await writeFile(join(directory, "new.mjs"), 'console.log("0.9.0")')
      await symlink(join(directory, "old.mjs"), entrypoint)
      const notice = await createMcpBuildNotice(entrypoint, "0.8.0")
      await symlink(join(directory, "new.mjs"), join(directory, "replacement"))
      await rename(join(directory, "replacement"), entrypoint)
      expect((await notice(result)).content[1]).toMatchObject({
        text: expect.stringContaining("now 0.9.0"),
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("warns from a running packaged MCP server after its file is replaced", async () => {
    const packaged = fileURLToPath(new URL("../../../bin/cohall.js", import.meta.url))
    const directory = await mkdtemp(join(dirname(packaged), "mcp-build-"))
    const entrypoint = join(directory, "cohall.js")
    const client = new Client({ name: "cohall-build-test", version: "1.0.0" })
    const relay = createServer((request, response) => {
      response.setHeader("content-type", "application/json")
      if (request.url !== "/api/devices") {
        response.statusCode = 404
        response.end(JSON.stringify({ error: "Route not found" }))
        return
      }
      response.end("[]")
    })
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve))
    try {
      await copyFile(packaged, entrypoint)
      const address = relay.address()
      if (address === null || typeof address === "string") throw new Error("Missing test port")
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [entrypoint, "mcp"],
        env: {
          COHALL_CONFIG: join(directory, "missing.json"),
          COHALL_CLIENT_TOKEN: "test-token",
          COHALL_RELAY_URL: `http://127.0.0.1:${address.port}`,
        },
        stderr: "pipe",
      })
      await client.connect(transport, { timeout: 5_000 })
      const runningVersion = client.getServerVersion()?.version
      expect(runningVersion).toBeDefined()
      const source = await readFile(entrypoint, "utf8")
      const updated = source.replace(/var version = "[^"\n]+"/, 'var version = "99.0.0"')
      expect(updated).not.toBe(source)
      await writeFile(join(directory, "replacement.js"), updated)
      await rename(join(directory, "replacement.js"), entrypoint)

      const output = z
        .object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })) })
        .parse(
          await client.callTool({ name: "list_devices", arguments: {} }, undefined, {
            timeout: 5_000,
          }),
        )
      const first = output.content[0]
      if (first === undefined) throw new Error("MCP result omitted its tool output")
      expect(JSON.parse(first.text)).toEqual([])
      expect(output.content[1]?.text).toContain(`still running ${runningVersion}`)
      expect(output.content[1]?.text).toContain("now 99.0.0")
      const next = await client.callTool({ name: "list_devices", arguments: {} }, undefined, {
        timeout: 5_000,
      })
      expect(next.content).toEqual([output.content[0]])
      expect(client.getServerVersion()?.version).toBe(runningVersion)
    } finally {
      await client.close()
      await new Promise<void>((resolve, reject) =>
        relay.close((error) => (error === undefined ? resolve() : reject(error))),
      )
      await rm(directory, { recursive: true, force: true })
    }
  })
})
