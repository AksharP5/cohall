# Agent integrations

CLI plus skill is the recommended integration. MCP is available for harnesses
that prefer native tool discovery. Both create the same relay tasks; use one
entry point per task.

## CLI plus skill

```bash
npx -y @akshar5/cohall skill install all
npx -y @akshar5/cohall doctor
```

This installs the embedded skill into:

- `~/.agents/skills/cohall` for Codex-compatible skill loaders;
- `~/.claude/skills/cohall` for Claude Code;
- `~/.config/opencode/skills/cohall` for OpenCode.

Any other harness with shell access can invoke the CLI directly. No Cohall UI
extension is required.

When delegating from a conversation, the sending agent must distill why the user
is asking, relevant facts and prior findings, constraints, and the intended
decision into Cohall's `context` field. Cohall cannot read the harness transcript
itself. Send a focused brief rather than the raw chat; omit context only for a
self-contained task.

## Codex MCP

```bash
codex mcp add cohall -- npx -y @akshar5/cohall mcp
```

Equivalent `~/.codex/config.toml`:

```toml
[mcp_servers.cohall]
command = "npx"
args = ["-y", "@akshar5/cohall", "mcp"]
```

## Claude Code MCP

```bash
claude mcp add --transport stdio --scope user cohall -- \
  npx -y @akshar5/cohall mcp
```

Equivalent project `.mcp.json`:

```json
{
  "mcpServers": {
    "cohall": {
      "command": "npx",
      "args": ["-y", "@akshar5/cohall", "mcp"]
    }
  }
}
```

## OpenCode MCP

Add to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "cohall": {
      "type": "local",
      "command": ["npx", "-y", "@akshar5/cohall", "mcp"],
      "enabled": true
    }
  }
}
```

## Isolated environments

The MCP subprocess reads the current user's Cohall configuration. If a harness
uses an isolated environment, pass `COHALL_CONFIG` with an absolute path to that
configuration file. Alternatively pass `COHALL_RELAY_URL` and
`COHALL_CLIENT_TOKEN` directly.

Never place an owner or device token in an MCP configuration. Both integrations
provide redacted task tracing through `cohall trace <task-id>` or the
`task_trace` MCP tool.
