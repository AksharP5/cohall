# Cohall

Cohall lets agents on your own devices delegate work to each other. It is a
headless bridge, not another agent app: keep using any harness that can run a
command or connect to a stdio MCP server.

One npm package provides a durable self-hosted relay, outbound-only device
workers, a CLI, an installable agent skill, an optional MCP server, and local
Codex, Claude Code, and OpenCode adapters, plus an experimental Grok Bot adapter.

## How it works

```text
Current agent
CLI + skill or MCP
       |
 HTTP(S) / WS(S)
       |
Cohall relay + SQLite
     /        \
 Mac agent   Linux agent
 Xcode       Docker
 browser     repositories
```

The relay stores tasks, results, thread history, and provider session IDs. Each
device uses its own files, provider login, tools, skills, permissions, and
signed-in services. Cohall does not expose a raw remote shell or copy
credentials between devices.

## What you can do

After installing the skill, ask naturally:

- “Ask `@macbook` to build the iOS app and diagnose the signing error.”
- “Have `@server` reproduce this failure against its Docker services.”
- “Use `@linux`'s signed-in browser to investigate this deployment.”
- “Queue the full test suite on `@server`; keep working here and report back.”

When a request depends on your current conversation, the sending agent
automatically includes a concise brief explaining why you are asking, relevant
facts and prior findings, constraints, and the decision you need. It does not
forward the raw transcript or unrelated private material.

## Get started with your agent

Paste this into an agent on the device you want to configure:

```text
Set up Cohall on this device using https://github.com/AksharP5/cohall. Read the current README and installation/service docs first. Detect this OS, package manager, installed provider CLIs, and suitable workspace roots. If no Cohall relay is configured, ask whether this device should host one or join an existing relay; do not guess a relay URL or token. Keep the relay private through Tailscale or HTTPS, never expose plain HTTP publicly, and keep every token out of command arguments, shell history, and logs. Install Cohall, pair or join this device, install its skill for the detected agent harnesses, configure autostart if this device should remain available, run cohall doctor, and report exactly what is working. Ask before making system-wide changes.
```

The agent will ask for the relay address and one-time pairing token only when it
needs them.

## Quick start

Cohall requires Node.js 24 or newer. Try it with your preferred package runner.
Each block is independently copyable.

**npm**

```bash
npx -y @akshar5/cohall --version
```

**Bun**

```bash
bunx @akshar5/cohall --version
```

**pnpm**

```bash
pnpm dlx @akshar5/cohall --version
```

**Yarn**

```bash
yarn dlx @akshar5/cohall --version
```

The remaining examples use `npx`.

### 1. Start a relay

```bash
export COHALL_TOKEN="$(openssl rand -hex 32)"
npx -y @akshar5/cohall relay
```

The relay binds to `127.0.0.1` by default. For multiple devices, run it on an
always-on machine and expose it only through a private network such as Tailscale
or an HTTPS reverse proxy. See [service setup](docs/services.md).

### 2. Pair a device

On an owner-authenticated machine, create a token that expires after ten minutes
and one exchange:

```bash
COHALL_RELAY_URL=https://cohall.example.com \
COHALL_TOKEN="$COHALL_TOKEN" \
npx -y @akshar5/cohall pair --label "MacBook"
```

Transfer the token privately. On the device being added, one guided command
configures the device and installs the agent skill. It defaults the device name
to the hostname and prompts for omitted values when run interactively:

```bash
read -rsp 'Pairing token: ' pairing_token; printf '\n'
printf '%s' "$pairing_token" | npx -y @akshar5/cohall init \
  --relay https://cohall.example.com \
  --providers codex \
  --workspace "$HOME/dev"
unset pairing_token
```

`cohall join` remains available for scripts that only want to exchange a
pairing token and write configuration.

Full-worker pairings associate both credentials with the same device. Once the
worker registers, its client requests record the source device and automatic
routing prefers an equally suitable peer. Older pairings keep working; pair the
worker again to enable source attribution and that routing preference. Forgetting
a device revokes both associated credentials. Client-only pairings have no worker
identity.

### 3. Keep the device available

```bash
npm install --global --prefix "$HOME/.local" @akshar5/cohall
cohall service install
cohall doctor
```

The service installer uses the current user's systemd manager on Linux,
launchd on macOS, and Task Scheduler on Windows. See
[service setup](docs/services.md) for boot-before-login and relay-host details.

## Move a relay

Move an existing relay to an always-on machine without pairing everything
again. On the current relay host:

```bash
cohall relay backup ./cohall-relay-backup
```

Copy that directory privately to the new host, install Cohall there, and restore
it as the user and data directory that will run the relay:

```bash
cohall relay restore ./cohall-relay-backup
cohall relay
```

After the new address is reachable, run this once on each configured client or
device:

```bash
cohall relay use https://new-relay.example.com
```

The switch verifies the existing credentials against the restored relay before
changing local configuration, then restarts an active device service. Remote
addresses require HTTPS by default. Use `--allow-http` only when another layer,
such as Tailscale, already encrypts the connection.

The backup contains the SQLite relay state, the plaintext owner token, and a
checksum manifest. Relay state includes devices, threads, prompts, results,
provider-session references, upgrade history, pairing records, and hashed
client/device sessions. It does not contain device-local files, provider
credentials, Cohall device configuration, service definitions, or reverse-proxy
TLS configuration. Transfer and store it like a secret. If the new host keeps
the same DNS or Tailscale address, clients need no configuration change. See
[moving a relay](docs/services.md#move-a-relay) for service-host details.

## Delegate work

```bash
npx -y @akshar5/cohall delegate \
  --target @macbook \
  --workspace "$HOME/dev/project" \
  --prompt 'Inspect the signed-in dashboard and identify why deployment 184 failed.' \
  --context 'Why: the deployment failed after local checks passed. Need: root cause, evidence, and recommended next step.'
```

The command waits for a result by default. Queue longer work with `--no-wait`,
then inspect it later:

```bash
npx -y @akshar5/cohall wait <task-id> --timeout 1800
npx -y @akshar5/cohall trace <task-id> --follow
```

`--timeout` accepts 5 to 86400 seconds and defaults to 900. It limits how long
the command waits; the task continues after that. Invalid timeout values are
rejected before any work is sent, including with `--no-wait`.

Reuse the returned `thread_id` for follow-ups so the target resumes its provider
session. Queued follow-ups pick up the preceding turn's session when they start,
including after a worker restart.

Delegated child tasks inherit their parent's thread. Cohall routes them away
from unfinished ancestors using the same worker slot, and rejects an explicit
target that would make them wait on an ancestor. A Bot can still delegate to
Codex or a different Bot on its own computer.

## Talk to your Grok Bots

The experimental `grok-bot` provider sends messages to existing named Bots
through the local Grok Bot gateway on their computer. It uses each Bot's current
conversation, tools, and permissions. Grok Bot remains the agent responding;
Codex is a separate provider that the Bot can delegate to.

On the Grok Bot computer, configure its gateway file and restart the Cohall
worker:

```bash
cohall configure --grok-gateway "$HOME/sand-data/gateway.json" --providers codex,grok-bot
```

The path can also be supplied as `COHALL_GROK_GATEWAY`. The gateway credential
stays on that computer; clients discover Bots through the Cohall relay. Upgrade
the relay, workers, and clients before enabling this provider. Restart
long-running MCP servers after updating their clients. A worker launched by a
custom supervisor needs an explicit restart after its package is upgraded.
The local gateway is
not a stable public Grok Bot API, so compatibility depends on the installed
Grok Bot version.

From any paired device:

```bash
cohall bots
cohall send @Research 'Find three useful projects to build this week.'
cohall send @Writer 'Draft a video outline for a small developer tool.'
cohall send --thread <returned-thread-id> 'Expand the second idea.'
```

Discovery lists every advertised Bot with its ID, host availability, and a
stable target. Names work when unique. For repeated names, use
`@device-name/BotName` or the `@device-id/bot-id` target from `cohall bots`.
Quote targets containing spaces. MCP clients have the equivalent `list_bots`
and `delegate` tools; the Bot target selects the provider automatically.

A Cohall thread records the exchange and lets follow-ups find the same Bot.
It does not create an isolated Grok Bot conversation: messages sent in the
Grok Bot app share that Bot's history. Bot tasks use the Bot's own permissions
and computer context, so omit `--workspace`. Queued Bot tasks that have never
been dispatched can be cancelled; active Bot turns must be stopped in Grok Bot because
the gateway cannot safely cancel a specific Cohall turn.
A dispatched Bot request remains non-cancellable through Cohall if a disconnect
or relay restart puts it back in the queue, even if its acceptance message was lost.
When upgrading an older relay without dispatch records, outstanding Bot requests
are conservatively treated as potentially dispatched.

Cohall includes a local callback command in each Bot request. After finishing,
the Bot hands its result back by running `cohall reply <task-id> --message-file
<path>` on its computer. The callback also accepts `--message -` for stdin,
`--message <text>`, or `--error <text>` when the Bot cannot complete the task.
It records the result locally without relay credentials or transcript scraping.
The task becomes completed when the worker receives this callback; a reply in
the Grok Bot chat alone does not complete it. If no callback arrives within six
hours of the first dispatch, Cohall reports failure. That deadline does not
stop the Bot's ongoing work.

Pending or uncertain prompt acceptance is checked until the gateway confirms
acceptance or rejection, including after a worker restart. A rejection fails
the task promptly; gateway outages still allow the local callback to complete
it. Cohall never resends an uncertain dispatch.

Bots can delegate through the installed Cohall CLI, including to Codex on the
same computer. Link child work to the parent task:

```bash
cohall delegate --target @cloud --provider codex \
  --thread <thread-id> --parent <parent-task-id> \
  --prompt 'Implement the agreed project in the local repository.'
```

Cohall passes the thread and parent task IDs to its spawned CLI agents, and
includes them in instructions sent to Grok Bots. Tasks for different Bots and
the computer's CLI worker can run concurrently; work for one Bot runs in order.
The Grok Bot computer, gateway, and Cohall worker must be running. On computers
without a startup service, arrange recovery using the host platform's routines;
Cohall cannot keep a suspended computer awake or survive erased state by itself.

## Manage all devices

Inspect the whole installation from any paired client:

```bash
cohall doctor --all
cohall versions
cohall usage
```

`doctor --all` reports connectivity, providers, workspaces, and version drift.
`usage` reports retained Cohall task activity by device, status, and provider;
provider token counts and billing are not available to the relay.

From the relay owner account, queue a Cohall upgrade for every registered
device and inspect progress:

```bash
cohall upgrade --all
cohall upgrades
# If a lost device can never finish its queued operation:
cohall upgrades abandon <operation-id>
```

Upgrade requests are durable for offline devices and run after active delegated
work. This is a typed owner-only maintenance operation, not remote shell access.
Every device must already run Cohall 0.5.0 or newer; upgrade older installations
individually once before using all-device upgrades.
Each target must use a global npm, Bun, or pnpm installation that can upgrade
itself. Preview the targets with `cohall upgrade --all --dry-run`, or pin an
exact release with `--to 1.2.3`. `cohall upgrades` returns the 50 newest results.
Abandonment is an owner recovery action for a permanently unreachable target;
it does not interrupt an upgrade that is already executing. Forgetting an
offline device also closes its outstanding maintenance operation.

## Optional MCP

CLI plus skill is the recommended integration. For a client that accepts the
common `mcpServers` format, paste:

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

CLI and MCP create the same tasks; use one entry point per task. See
[agent integrations](docs/integrations.md) for Codex, Claude Code, and OpenCode
configuration.

## Reliability and security

- Accepted tasks persist in SQLite while a target is offline.
- Interrupted work is re-queued with at-least-once delivery; consequential work
  should be safe to retry.
- The relay must be reachable to submit new work, but persisted tasks survive a
  relay restart.
- The relay retains the newest 1,000 terminal tasks by default so history cannot
  grow without bound.
- Paired clients can ask a device's local provider to act with that user's normal
  authority. Pair only devices and users you trust.
- Workspace roots are enforced after resolving symlinks, credentials are
  role-separated, and task traces omit prompts, results, tokens, and provider
  session IDs.

## Documentation

- [Installation, pairing, providers, and upgrades](docs/install.md)
- [Agent skill and MCP integrations](docs/integrations.md)
- [Linux, macOS, and Windows services](docs/services.md)
- [Contributing](CONTRIBUTING.md)

Cohall is licensed under the [MIT License](LICENSE).
