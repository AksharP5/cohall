import { version } from "@cohall/protocol"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

export const checkMcp = async (
  entrypoint: string,
  relayUrl: string,
  token: string,
): Promise<{ status: "ok"; tool_count: number } | { status: "error"; error: string }> => {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value
  }
  env.COHALL_RELAY_URL = relayUrl
  env.COHALL_CLIENT_TOKEN = token

  const client = new Client({ name: "cohall-doctor", version })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint, "mcp"],
    env,
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
