# Agent integrations

CLI plus skill is the recommended integration. MCP is available for harnesses
that prefer native tool discovery. Both create the same relay tasks; use one
entry point per task.

For queued work, `cohall inbox` or the MCP `completion_inbox` tool lists questions
awaiting answers and results the sending client has not handled. Fetch a full
result with `cohall status <task-id>` or `task_status`, then use
`cohall inbox ack <task-id>` or `acknowledge_completion` to remove it from the inbox. A synchronous `delegate`
call acknowledges its result automatically.

## Clarification and resume

A worker missing essential information can ask the sender, then end its current
turn immediately:

```bash
cohall request-input --question 'Which branch should I use?'
```

The task and current turn IDs are inherited during delegated coding work.
Outside that environment, supply `<task-id>` explicitly. `--run-id <run-id>`
selects a specific worker turn; otherwise Cohall reads the task's current turn.
MCP provides `task_request_input` with `question`, optional `task_id`, and optional
`run_id`. Grok Bots use the callback command supplied in their handoff with
`--question` and its `--run-id`.

After the worker ends its turn, the task becomes `needs_input` and frees its
worker slot. `delegate`, `send`, and `wait` return at this state as well as at a
terminal result. Read `input_request.id` and `input_request.question` in their
JSON or `status`; inbox entries use `inputRequest` instead. Questions cannot be
acknowledged as completions.

The original requester credential or relay owner answers the current question:

```bash
cohall answer <task-id> --request-id <question-id> --message 'Use main.'
cohall wait <task-id> --timeout 1800
```

Answers also support `--message-file <path>` or `--message -` for stdin. MCP
provides `task_answer` with `task_id`, `request_id`, and `answer`, followed by
`wait_task`. A stale question ID or duplicate answer is rejected. Use known
facts from the conversation; ask the user when the answer is missing.

The same task and thread resume on their original target, using the saved
provider session when available. Answered questions are included in the resumed
prompt, including after a restart. An offline target waits in the queue. Each
task permits ten questions; each question and answer must be nonblank and at most
4096 UTF-8 bytes. Cancel a paused task with `cohall cancel <task-id>`.
Coding task cancellation stays `cancelling` until the worker confirms termination,
including for paused tasks. An offline worker acknowledges it after reconnecting.

The assigned task, including its prompt, context, and clarification history,
must fit the 1 MiB transfer limit. Oversized assignments fail with an explicit
error; retry with a shorter prompt or context.

Upgrade the relay, requester, and worker before using clarification. Resumed
tasks and Bot turns using a run ID remain queued while the worker lacks
clarification support. Inbox checks
and waits poll the relay; Cohall does not wake a requester to deliver a question.

## Worker progress

Workers can report a brief milestone with `cohall progress --message "Running
tests"` or MCP `task_progress`. Both inherit the task ID during delegated work;
otherwise supply the task ID explicitly. Notes must be nonblank and at most
1024 UTF-8 bytes. Only the task's target device or relay owner may update a
running task. Use milestones, never logs or secrets.

`cohall status <task-id>`, `cohall trace <task-id> --follow`, and MCP `task_status`
and `task_trace` include the latest note and timestamp. Notes replace one another
and clear when work is requeued, pauses for input, or finishes.
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

A running MCP server checks its launched executable at most once per minute
when returning tool results. If that file changes to a different Cohall version,
the next checked result includes a notice to restart the Cohall MCP connection
in your agent host. Each detected version produces one notice; the tool's
normal result is preserved. The server does not restart an active session.
Version probes time out after two seconds and failed probes retry on a later
tool call. This detects changes to the launched file, including a replaced
symlink target. It does not check the npm registry or other installations. An
`npx` session using an unchanged cache path must be restarted to load a newer
package.

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

For a hosted Muse sandbox, see [Muse requester setup](muse.md) for client-only
pairing, proxy access, and collecting delegated results.

The MCP subprocess reads the current user's Cohall configuration. If a harness
uses an isolated environment, pass `COHALL_CONFIG` with an absolute path to that
configuration file. Alternatively pass `COHALL_RELAY_URL` and
`COHALL_CLIENT_TOKEN` directly.

Never place an owner or device token in an MCP configuration. Task tracing through
`cohall trace <task-id>` or `task_trace` omits prompts, final results, credentials,
and provider session IDs. It includes worker progress and clarification text;
inspect those fields before sharing a trace.
