# Agent harness integrations

CLI plus skill is the recommended integration. MCP is available for hosts that
prefer native tool discovery. Both use the same relay and device protocol.

## CLI plus skill

```bash
npx -y cohall skill install all
npx -y cohall doctor
```

This installs the same embedded `SKILL.md` into:

- `~/.agents/skills/cohall` for Codex-compatible skill loaders;
- `~/.claude/skills/cohall` for Claude Code;
- `~/.config/opencode/skills/cohall` for OpenCode.

T3Code, Buzz, and other harnesses can run `npx -y cohall` from their normal
shell/tool environment. `bunx cohall`, `pnpm dlx cohall`, and `yarn dlx cohall`
are equivalent. No Cohall-specific UI extension is required.

## Codex MCP

```bash
codex mcp add cohall -- npx -y cohall mcp
```

Or configure `~/.codex/config.toml`:

```toml
[mcp_servers.cohall]
command = "npx"
args = ["-y", "cohall", "mcp"]
```

## Claude Code MCP

```bash
claude mcp add --scope user cohall -- npx -y cohall mcp
```

## OpenCode MCP

Add a local stdio MCP server with command array
`["npx", "-y", "cohall", "mcp"]`.

## Environment

The MCP subprocess reads the normal per-user Cohall configuration. If a harness
uses an isolated environment, pass only:

```text
COHALL_CONFIG=/absolute/path/to/config.json
```

Or pass `COHALL_RELAY_URL` and `COHALL_CLIENT_TOKEN` directly. Never place an
owner or device token in an MCP client configuration.

CLI and MCP are equivalent entry points. Use one per delegated task.
Replace the `npx`, `-y`, `cohall` command prefix with `bunx`, `cohall` or
`pnpm`, `dlx`, `cohall` when that better matches the host.
