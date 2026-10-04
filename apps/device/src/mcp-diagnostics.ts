import { version } from "@cohall/protocol"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js"
import { configurationPath } from "./config.ts"

export const checkMcp = async (
  entrypoint: string,
  relayUrl: string,
  token: string,
): Promise<{ status: "ok"; tool_count: number } | { status: "error"; error: string }> => {
  const client = new Client({ name: "cohall-doctor", version })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint, "mcp"],
    env: {
      ...getDefaultEnvironment(),
      COHALL_CONFIG: configurationPath(),
      COHALL_MCP_SELF_TEST: "1",
      COHALL_RELAY_URL: relayUrl,
      COHALL_CLIENT_TOKEN: token,
    },
    stderr: "pipe",
  })

  try {
    await client.connect(transport, { timeout: 5_000 })
    const { tools } = await client.listTools(undefined, { timeout: 5_000 })
    if (tools.length === 0) return { status: "error", error: "MCP server exposed no tools" }
    return { status: "ok", tool_count: tools.length }
  } catch (cause) {
    return { status: "error", error: cause instanceof Error ? cause.message : String(cause) }
  } finally {
    await client.close()
  }
}

export {
  readMcpHostDiagnostics,
  type McpHostDiagnostics,
  type McpHostSession,
} from "./mcp-host-diagnostics.ts"
