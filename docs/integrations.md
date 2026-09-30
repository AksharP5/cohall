# Agent integrations

CLI plus skill is the recommended integration. MCP is available for harnesses
that prefer native tool discovery. Both create the same relay tasks; use one
entry point per task.

For queued work, `cohall inbox` or the MCP `completion_inbox` tool lists results
the sending client has not handled. Fetch a full result with `cohall status
<task-id>` or `task_status`, then use `cohall inbox ack <task-id>` or
`acknowledge_completion` to remove it from the inbox. A synchronous `delegate`
call acknowledges its result automatically.

Workers can report a brief milestone with `cohall progress --message "Running
tests"` or MCP `task_progress`. Both inherit the task ID during delegated work;
otherwise supply the task ID explicitly. Notes must be nonblank and at most
1024 UTF-8 bytes. Only the task's target device or relay owner may update a
running task. Use milestones, never logs or secrets.

`cohall status <task-id>`, `cohall trace <task-id> --follow`, and MCP `task_status`
and `task_trace` include the latest note and timestamp. Notes replace one another
and clear when work is requeued or finishes.
Reporting progress requires an updated relay; it does not change task status
or acknowledge a completion.

## CLI plus skill

```bash
npx -y @akshar5/cohall skill install all
npx -y @akshar5/cohall doctor
```

This installs the embedded skill into:

- `~/.agents/skills/cohall` for Codex-compatible skill loaders;
- `~/.claude/skills/cohall` for Claude Code;
- `~/.config/opencode/skills/cohall` for OpenCode.

With a client credential, `doctor` starts Cohall's MCP server and verifies that
it lists tools. This checks the local server; the agent host still needs a
working MCP configuration to load it.

`doctor` also checks the client credential with an authenticated relay request.
The `client_authentication` result separates rejected credentials and relay
request failures from an offline device. `client_credential` reports only
whether a credential is configured. The authentication check is skipped when
the relay is unreachable or no client credential is configured.

Any other harness with shell access can invoke the CLI directly. No Cohall UI
extension is required.

Use `cohall bots` to discover named Grok Bots and `cohall send @BotName` to
message one. MCP exposes the same discovery through `list_bots`; `delegate`
infers `grok-bot` from a Bot target. See [Grok Bot setup](../README.md#talk-to-your-grok-bots)
for messaging details, and [computer setup](grok-bot.md) for Tailscale, pairing,
and the local gateway.

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
