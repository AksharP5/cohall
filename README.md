# Cohall

Cohall lets agents on your own devices delegate work to each other. It is a
headless interoperability layer, not another agent harness: use it from Codex,
Claude Code, OpenCode, T3Code, Buzz, or any other tool that can run a command or
connect to a stdio MCP server.

One npm package provides:

- a durable self-hosted relay;
- an outbound-only device daemon;
- a human and agent-friendly CLI;
- one embedded, installable agent skill;
- an optional stdio MCP server;
- local Codex, Claude Code, and OpenCode execution adapters.

There is no Cohall desktop or web app. Your existing harness remains the UI.

## Architecture

```text
Codex / Claude Code / OpenCode / T3Code / Buzz
                 CLI + skill or MCP
                          |
                    HTTPS / WSS
                          |
              Cohall relay + SQLite
                   /              \
          Mac device daemon    Linux device daemon
          local agent login    local agent login
          browser / Xcode      repos / Docker
```

The relay stores task prompts, final results, thread history, and provider
session IDs. It does not plan work, copy device credentials, or SSH into a
machine. Each device runs its own provider CLI with its existing local login,
configuration, skills, MCP servers, permissions, and workspace access.

## Quick start

Run Cohall anywhere Node.js 24 or newer is installed. Use whichever JavaScript
package manager is already available:

```bash
npx -y @akshar5/cohall --version
bunx @akshar5/cohall --version
pnpm dlx @akshar5/cohall --version
yarn dlx @akshar5/cohall --version
```

The examples below use `npx`; the other runners are interchangeable.

Start a local relay with an explicit owner token:

```bash
export COHALL_TOKEN="$(openssl rand -hex 32)"
npx -y @akshar5/cohall relay
```

The relay binds only to `127.0.0.1` by default. To expose it through a private
network or TLS reverse proxy, set `COHALL_RELAY_HOST=0.0.0.0` and explicitly opt
in with `COHALL_RELAY_ALLOW_REMOTE=true`. Do not expose plain HTTP to the public
internet.

Create a one-time pairing credential on an owner-authenticated machine:

```bash
COHALL_RELAY_URL=https://cohall.example.com \
COHALL_TOKEN="$COHALL_TOKEN" \
npx -y @akshar5/cohall pair --label "MacBook"
```

Transfer the token to the machine being added through a private channel, then
provide it on stdin so it never appears in process arguments or shell history:

```bash
read -rsp 'Pairing token: ' pairing_token; printf '\n'
printf '%s' "$pairing_token" | npx -y @akshar5/cohall join \
  --relay https://cohall.example.com \
  --name macbook \
  --workspace "$HOME/dev" \
  --workspace "$HOME/.skillsync/repo"
unset pairing_token

npx -y @akshar5/cohall doctor
npx -y @akshar5/cohall device
```

`join` exchanges the one-time token for separate client and device credentials,
then writes a per-user configuration file with Unix mode `0600`. Workspace roots
must already exist and are resolved to canonical paths.

## Use from an agent

Install the same embedded skill for Codex, Claude Code, and OpenCode:

```bash
npx -y @akshar5/cohall skill install all
```

Then delegate from any harness with shell access:

```bash
npx -y @akshar5/cohall devices
npx -y @akshar5/cohall delegate \
  --target @macbook \
  --provider codex \
  --workspace /Users/me/dev/project \
  --prompt 'Inspect the signed-in dashboard and identify why deployment 184 failed.' \
  --context 'Focus on events after 15:00 UTC and return supporting links.'
```

The command waits by default and returns JSON. For asynchronous work:

```bash
npx -y @akshar5/cohall delegate --target @linux --no-wait \
  --prompt 'Run the test suite and report failures.'
npx -y @akshar5/cohall wait <task-id> --timeout 1800
npx -y @akshar5/cohall cancel <task-id>
npx -y @akshar5/cohall trace <task-id> --follow
npx -y @akshar5/cohall thread <thread-id>
```

Follow-ups using the same `thread_id` resume the provider session on the target
device. Active cancellation remains `cancelling` until the target acknowledges
that its local process stopped. `trace` reports the durable relay and device
lifecycle without prompts, results, credentials, or provider session IDs.
`--follow` emits changed snapshots as newline-delimited JSON until the task is
terminal.

## Optional MCP

Run `npx -y @akshar5/cohall integrations` for current setup commands. The MCP
server exposes:

- `list_devices`
- `delegate`
- `task_status`
- `task_trace`
- `wait_task`
- `cancel_task`
- `thread_context`

CLI plus skill and MCP create the same tasks. Configure one or the other in a
given harness; do not submit the same work through both.

See [integration examples](docs/integrations.md), [installation](docs/install.md),
and [service setup](docs/services.md).

## Provider behavior

Target devices advertise only provider executables they actually have:

| Provider    | Required command | Session continuation     |
| ----------- | ---------------- | ------------------------ |
| Codex       | `codex`          | `codex exec resume`      |
| Claude Code | `claude`         | `claude --resume`        |
| OpenCode    | `opencode`       | `opencode run --session` |

Cohall does not bypass provider permissions. A paired client is authorized to
ask the local provider to act with that user account's normal authority, so do
not pair mutually untrusted users. Provider output and task backlogs are
bounded, one task runs at a time per device, and configured workspace roots are
enforced after resolving symlinks.

## Configuration

`npx -y @akshar5/cohall config` shows the active stored configuration without
printing tokens. `npx -y @akshar5/cohall configure` changes relay, name,
workspaces, model, or Codex sandbox.
Environment variables override stored values:

| Variable                                  | Purpose                                        |
| ----------------------------------------- | ---------------------------------------------- |
| `COHALL_CONFIG`                           | Configuration file override                    |
| `COHALL_RELAY_URL`                        | Relay URL for CLI, MCP, and device             |
| `COHALL_CLIENT_TOKEN`                     | Client credential override                     |
| `COHALL_DEVICE_TOKEN`                     | Device credential override                     |
| `COHALL_TOKEN`                            | Relay owner credential                         |
| `COHALL_DEVICE_ID`                        | Stable device ID override                      |
| `COHALL_DEVICE_NAME`                      | Advertised device name                         |
| `COHALL_DEVICE_WORKSPACES`                | Comma-separated workspace roots                |
| `COHALL_DEVICE_WORKSPACES_JSON`           | JSON workspace roots; supports commas in paths |
| `COHALL_MODEL`                            | Target provider model override                 |
| `COHALL_SANDBOX`                          | Codex sandbox override                         |
| `COHALL_THREAD_ID`                        | Inherited Cohall thread for nested delegation  |
| `COHALL_DATA_DIR`                         | Relay database and owner-token directory       |
| `COHALL_RELAY_HOST` / `COHALL_RELAY_PORT` | Relay listener                                 |
| `COHALL_RELAY_ALLOW_REMOTE`               | Explicit non-loopback binding opt-in           |

The owner token can create pairing credentials, list sessions, and revoke them.
Ordinary client and device credentials are role-separated, device-bound where
applicable, expiring, and stored only as SHA-256 hashes by the relay.

## Development

```bash
bun install
bun run check
```

`bun run check` type-checks, lints, builds the npm executable, and tests the full
relay/device/CLI/MCP path with fake provider executables. GitHub Actions is
deliberately low-frequency because this is a private repository. See [release
operations](docs/releasing.md).

The relay guarantees durable at-least-once task delivery. Task assignment and
terminal events are idempotent; interrupted running tasks are re-queued after a
device or relay restart. A device accepts at most 100 outstanding tasks and
executes them one at a time. Thread context returns a byte-bounded recent window
and sets `truncated` when older content exists.
