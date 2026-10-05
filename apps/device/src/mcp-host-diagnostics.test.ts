import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { execa } from "execa"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { expect, it, vi } from "vitest"
import { checkMcp, readMcpHostDiagnostics } from "./mcp-diagnostics.ts"

const entrypoint = fileURLToPath(new URL("../../../bin/cohall.js", import.meta.url))
const token = "private-test-credential-never-record"
const resultText = "private-test-result-never-record"

const withHost = async (
  test: (fixture: {
    directory: string
    configPath: string
    relayUrl: string
    transport: (configPath?: string) => { transport: StdioClientTransport; stderr: () => string }
    connect: (
      configPath?: string,
      identity?: { name: string; version: string },
    ) => Promise<{ client: Client; stderr: () => string }>
  }) => Promise<void>,
  preload?: string,
) => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-mcp-host-test-"))
  const configPath = join(directory, "config.json")
  const connections: Array<{ close: () => Promise<void> }> = []
  const relay = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the real client's request without retaining its body.
    }
    response.setHeader("content-type", "application/json")
    if (request.url === "/api/devices") return void response.end("[]")
    if (request.url === "/api/devices/page") {
      return void response.writeHead(404).end(JSON.stringify({ error: "Route not found" }))
    }
    response.writeHead(503).end(JSON.stringify({ error: resultText }))
  })
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve))
  const address = relay.address()
  if (address === null || typeof address === "string") throw new Error("Missing test port")
  const relayUrl = `http://127.0.0.1:${address.port}`
  const transport = (selected = configPath) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        ...(preload === undefined ? [] : ["--import", pathToFileURL(preload).href]),
        entrypoint,
        "mcp",
      ],
      env: {
        PATH: process.env.PATH ?? "",
        COHALL_CONFIG: selected,
        COHALL_RELAY_URL: relayUrl,
        COHALL_CLIENT_TOKEN: token,
      },
      stderr: "pipe",
    })
    let stderr = ""
    transport.stderr?.on("data", (data: Buffer) => {
      stderr = `${stderr}${data.toString("utf8")}`.slice(-4_096)
    })
    connections.push(transport)
    return { transport, stderr: () => stderr }
  }
  const connect = async (
    selected = configPath,
    identity = { name: "test-host", version: "1.2.3" },
  ) => {
    const connection = transport(selected)
    const client = new Client(identity)
    await client.connect(connection.transport, { timeout: 5_000 })
    return { client, stderr: connection.stderr }
  }
  try {
    await test({ directory, configPath, relayUrl, transport, connect })
  } finally {
    await Promise.all(connections.map((connection) => connection.close()))
    relay.closeAllConnections()
    await new Promise<void>((resolve) => relay.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}

it("does not count the doctor's successful self-test as a host connection", async () => {
  await withHost(async ({ configPath, relayUrl }) => {
    vi.stubEnv("COHALL_CONFIG", configPath)
    try {
      expect(await readMcpHostDiagnostics()).toMatchObject({
        status: "not_observed",
        sessions: [],
        warnings: [],
      })
      expect(await checkMcp(entrypoint, relayUrl, token)).toMatchObject({ status: "ok" })
      expect(await readMcpHostDiagnostics()).toMatchObject({
        status: "not_observed",
        sessions: [],
        warnings: [],
      })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

it("records real initialization, discovery, received calls and shutdown without payloads", async () => {
  await withHost(async ({ configPath, relayUrl, connect }) => {
    const { client, stderr } = await connect()
    await vi.waitFor(
      async () => {
        expect(await readMcpHostDiagnostics(configPath), stderr()).toMatchObject({
          status: "observed",
          sessions: [
            { client: { name: "test-host", version: "1.2.3" }, initialized_at: expect.any(String) },
          ],
        })
      },
      { timeout: 5_000 },
    )
    const { tools } = await client.listTools()
    await client.callTool({ name: "list_devices", arguments: {} })
    const prompt = "private-test-prompt-never-record"
    const failed = await client.callTool({
      name: "task_progress",
      arguments: { task_id: "11111111-1111-4111-8111-111111111111", note: prompt },
    })
    expect(failed).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining(resultText) }],
    })
    await vi.waitFor(
      async () => {
        expect(await readMcpHostDiagnostics(configPath), stderr()).toMatchObject({
          status: "observed",
          warnings: [],
          sessions: [
            {
              tools_list: { tool_count: tools.length, at: expect.any(String) },
              tools_call_count: 2,
              last_tool_call_at: expect.any(String),
            },
          ],
        })
      },
      { timeout: 5_000 },
    )
    await client.close()
    await vi.waitFor(
      async () =>
        expect((await readMcpHostDiagnostics(configPath)).sessions[0]?.closed_at).toEqual(
          expect.any(String),
        ),
      { timeout: 5_000 },
    )
    const directory = `${configPath}.mcp-hosts`
    const names = await readdir(directory)
    expect(names).toHaveLength(1)
    const name = names[0]
    if (name === undefined) throw new Error("Missing launch record")
    const raw = await readFile(join(directory, name), "utf8")
    for (const privateValue of [
      prompt,
      resultText,
      token,
      relayUrl,
      "task_progress",
      "arguments",
      "content",
      "environment",
    ])
      expect(raw).not.toContain(privateValue)
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(4_096)
  })
})

it.each(["transient", "persistent"] as const)(
  "handles %s Windows-style storage contention while serving MCP tools",
  async (failure) => {
    const directory = await mkdtemp(join(tmpdir(), "cohall-mcp-storage-fault-"))
    const preload = join(directory, "storage-fault.mjs")
    await writeFile(
      preload,
      `import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const rename = filesystem.rename;
let rejected = false;
filesystem.rename = async (source, target) => {
  if (String(source).includes(".mcp-hosts")) {
    const snapshot = JSON.parse(await filesystem.readFile(source, "utf8"));
    if (snapshot.tools_call_count > 0 && (${JSON.stringify(failure)} === "persistent" || !rejected)) {
      rejected = true;
      throw Object.assign(new Error("Synthetic file contention"), { code: "EPERM" });
    }
  }
  return rename(source, target);
};
syncBuiltinESMExports();`,
    )
    try {
      await withHost(async ({ configPath, connect }) => {
        const { client, stderr } = await connect()
        await client.listTools()
        await vi.waitFor(
          async () =>
            expect((await readMcpHostDiagnostics(configPath)).sessions[0]?.initialized_at).toEqual(
              expect.any(String),
            ),
          { timeout: 5_000 },
        )
        await client.callTool({ name: "list_devices", arguments: {} })
        if (failure === "transient") {
          await vi.waitFor(
            async () =>
              expect(
                (await readMcpHostDiagnostics(configPath)).sessions[0]?.tools_call_count,
                stderr(),
              ).toBe(1),
            { timeout: 5_000 },
          )
          expect(stderr()).not.toContain("Cohall MCP host diagnostics are unavailable")
        } else {
          await vi.waitFor(
            () => expect(stderr()).toContain("Cohall MCP host diagnostics are unavailable (EPERM)"),
            { timeout: 5_000 },
          )
          await client.callTool({ name: "list_devices", arguments: {} })
          expect((await readMcpHostDiagnostics(configPath)).sessions[0]?.tools_call_count).toBe(0)
          expect(
            (stderr().match(/Cohall MCP host diagnostics are unavailable/g) ?? []).length,
          ).toBe(1)
        }
        await client.close()
      }, preload)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)

it("keeps concurrent host launches and selected configurations separate", async () => {
  await withHost(async ({ directory, configPath, connect }) => {
    const otherConfig = join(directory, "other.json")
    const hosts = await Promise.all([
      connect(configPath, { name: "first-host", version: "1" }),
      connect(configPath, { name: "second-host", version: "2" }),
      connect(otherConfig, { name: "other-config-host", version: "3" }),
    ])
    await Promise.all(
      hosts.map(async ({ client }) => {
        await client.listTools()
        await client.close()
      }),
    )
    const first = await readMcpHostDiagnostics(configPath)
    const other = await readMcpHostDiagnostics(otherConfig)
    expect(first.sessions.map((session) => session.client?.name).sort()).toEqual([
      "first-host",
      "second-host",
    ])
    expect(new Set(first.sessions.map((session) => session.launch_id)).size).toBe(2)
    expect(other.sessions.map((session) => session.client?.name)).toEqual(["other-config-host"])
  })
})

it("bounds retained launches, client identity size and stale storage", async () => {
  await withHost(async ({ configPath, connect }) => {
    for (let index = 0; index < 9; index += 1) {
      const { client } = await connect(configPath, {
        name: "h".repeat(10_000),
        version: "v".repeat(10_000),
      })
      await client.listTools()
      await client.close()
    }
    const directory = `${configPath}.mcp-hosts`
    const records = await readdir(directory)
    expect(records).toHaveLength(8)
    const report = await readMcpHostDiagnostics(configPath)
    expect(report.sessions).toHaveLength(8)
    for (const session of report.sessions) {
      expect(session.client?.name).toHaveLength(128)
      expect(session.client?.version).toHaveLength(128)
    }
    for (const record of records)
      expect((await stat(join(directory, record))).size).toBeLessThanOrEqual(4_096)
    const stale = records[0]
    if (stale === undefined) throw new Error("Missing stale record fixture")
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000)
    await utimes(join(directory, stale), old, old)
    expect((await readMcpHostDiagnostics(configPath)).sessions).toHaveLength(7)
    const { client } = await connect()
    await client.close()
    expect(await readdir(directory)).not.toContain(stale)
    expect((await readMcpHostDiagnostics(configPath)).sessions).toHaveLength(8)
  })
})

it("keeps MCP tools working when diagnostics cannot be written and reports the failure once", async () => {
  await withHost(async ({ configPath, connect }) => {
    await writeFile(`${configPath}.mcp-hosts`, "Blocked diagnostics directory")
    const { client, stderr } = await connect()
    expect((await client.listTools()).tools.length).toBeGreaterThan(0)
    await client.callTool({ name: "list_devices", arguments: {} })
    await client.close()
    expect((stderr().match(/Cohall MCP host diagnostics are unavailable/g) ?? []).length).toBe(1)
    expect(stderr()).toMatch(/unavailable \((?:EEXIST|ENOTDIR)\)/)
    expect(await readMcpHostDiagnostics(configPath)).toMatchObject({
      status: "unavailable",
      sessions: [],
      error: expect.stringContaining("Restore access"),
    })
  })
})

it.each(["invalid JSON", "x".repeat(4_097)])(
  "makes a corrupt or oversized saved record visible (%#)",
  async (body) => {
    await withHost(async ({ configPath, connect }) => {
      const directory = `${configPath}.mcp-hosts`
      await mkdir(directory)
      await writeFile(join(directory, `${randomUUID()}.json`), body)
      expect(await readMcpHostDiagnostics(configPath)).toMatchObject({
        status: "unavailable",
        sessions: [],
        warnings: [expect.stringContaining("Reset the diagnostics directory")],
      })
      const { client } = await connect()
      await client.listTools()
      await client.close()
      expect(await readMcpHostDiagnostics(configPath)).toMatchObject({
        status: "observed",
        warnings: [expect.stringContaining("could not be read")],
      })
    })
  },
)

it("distinguishes a launch without initialization from a failure before MCP startup", async () => {
  await withHost(async ({ directory, configPath, relayUrl, transport }) => {
    const connection = transport()
    await connection.transport.start()
    await vi.waitFor(
      async () => expect((await readMcpHostDiagnostics(configPath)).sessions).toHaveLength(1),
      { timeout: 5_000 },
    )
    await connection.transport.close()
    expect(await readMcpHostDiagnostics(configPath)).toMatchObject({
      status: "not_observed",
      sessions: [{ closed_at: expect.any(String) }],
      warnings: [expect.stringContaining("without client initialization")],
    })
    const missing = join(directory, "missing-credential.json")
    await expect(
      execa(process.execPath, [entrypoint, "mcp"], {
        extendEnv: false,
        env: { PATH: process.env.PATH ?? "", COHALL_CONFIG: missing, COHALL_RELAY_URL: relayUrl },
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("No client credential") })
    expect(await readMcpHostDiagnostics(missing)).toMatchObject({
      status: "not_observed",
      sessions: [],
      warnings: [],
    })
  })
})

it("explains incomplete historical discovery without claiming a live connection", async () => {
  await withHost(async ({ configPath, connect }) => {
    const { client } = await connect()
    await client.close()
    const report = await readMcpHostDiagnostics(configPath)
    expect(report).toMatchObject({
      status: "observed",
      sessions: [{ closed_at: expect.any(String) }],
      warnings: [expect.stringContaining("no tool discovery or calls were observed")],
    })
    const session = report.sessions[0]
    if (session === undefined || session.initialized_at === undefined)
      throw new Error("Missing initialized launch")
    await writeFile(
      join(report.path, `${session.launch_id}.json`),
      JSON.stringify({
        ...session,
        tools_list: { at: session.initialized_at, tool_count: 0 },
      }),
    )
    expect(await readMcpHostDiagnostics(configPath)).toMatchObject({
      status: "observed",
      warnings: [expect.stringContaining("returned an empty tools list")],
    })
  })
})
