# Agent harness integrations

CLI plus skill is the recommended integration. MCP is available for hosts that
prefer native tool discovery. Both use the same relay and device protocol.

## CLI plus skill

```bash
npx -y @akshar5/cohall skill install all
npx -y @akshar5/cohall doctor
```

This installs the same embedded `SKILL.md` into:

- `~/.agents/skills/cohall` for Codex-compatible skill loaders;
- `~/.claude/skills/cohall` for Claude Code;
- `~/.config/opencode/skills/cohall` for OpenCode.

T3Code, Buzz, and other harnesses can run `npx -y @akshar5/cohall` from their
normal shell/tool environment. `bunx @akshar5/cohall`, `pnpm dlx
@akshar5/cohall`, and `yarn dlx @akshar5/cohall` are equivalent. No
Cohall-specific UI extension is required.

## Codex MCP

```bash
codex mcp add cohall -- npx -y @akshar5/cohall mcp
```

Or configure `~/.codex/config.toml`:

```toml
[mcp_servers.cohall]
command = "npx"
args = ["-y", "@akshar5/cohall", "mcp"]
```

## Claude Code MCP

```bash
claude mcp add --scope user cohall -- npx -y @akshar5/cohall mcp
```

## OpenCode MCP

Add a local stdio MCP server with command array
`["npx", "-y", "@akshar5/cohall", "mcp"]`.

## Environment

The MCP subprocess reads the normal per-user Cohall configuration. If a harness
uses an isolated environment, pass only:

```text
COHALL_CONFIG=/absolute/path/to/config.json
```

Or pass `COHALL_RELAY_URL` and `COHALL_CLIENT_TOKEN` directly. Never place an
owner or device token in an MCP client configuration.

CLI and MCP are equivalent entry points. Use one per delegated task.
Both expose redacted task tracing through `cohall trace <task-id>` and the
`task_trace` MCP tool.
Replace the `npx`, `-y`, `@akshar5/cohall` command prefix with `bunx`,
`@akshar5/cohall` or `pnpm`, `dlx`, `@akshar5/cohall` when that better matches
the host.
