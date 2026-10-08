# Cohall

Cohall lets agents on your own devices delegate work to each other. It is a
headless bridge, not another agent app: keep using any harness that can run a
command or connect to a stdio MCP server.

One npm package provides a durable self-hosted relay, outbound-only device
workers, a CLI, an installable agent skill, an optional MCP server, and local
Codex, Claude Code, and OpenCode adapters, plus an experimental Grok Bot adapter.

https://github.com/user-attachments/assets/7db8ebb2-da77-484f-bba9-703a44f95f4a

<details>
<summary>Video music credits</summary>

Music: ["Hang Low" by Rewob (feat. DustyZonda)](https://ccmixter.org/files/rewob/69753),
including ["Hang Low a capella - Ashes and Dreams - main vox" by DustyZonda (feat. Liv Mircea)](https://ccmixter.org/files/DustyZonda/60053).
Both licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).
Trimmed and mixed for this video.

</details>

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
Set up Cohall on this device. Follow https://github.com/AksharP5/cohall/blob/main/docs/onboarding.md. First determine whether this machine should host a relay or join an existing one. Complete the matching path and its verification steps, including a harmless delegation. Use my existing authorization for installation and autostart; ask before additional system-wide changes. Keep tokens private and report exactly what is working.
```

The agent will ask for the relay address and one-time pairing token only when it
needs them.

You can also read the same guide with `npx -y @akshar5/cohall onboard`.

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
changing local configuration, then restarts an active device service. Stopped
workers stay stopped. Repeat the command to retry a failed restart, even when
the address is already saved. Remote addresses require HTTPS by default. Use
`--allow-http` only when another layer,
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

The command waits for a result or a clarification question by default. Queue
longer work with `--no-wait`, then inspect it later:

```bash
npx -y @akshar5/cohall wait <task-id> --timeout 1800
npx -y @akshar5/cohall trace <task-id> --follow
```

If a submission response is lost, retry with a UUID v4 generated before the
first attempt. Supply it through `--request-id` or MCP `delegate.request_id` and
keep the input and client credential unchanged. Cohall returns the original
task's current status. Use a device ID or `@device-id/bot-id` target so discovery
changes cannot affect the retry. See [retrying submissions](docs/integrations.md#retrying-submissions)
for limits and retention.

Task status and traces include the worker's latest progress note when it reports
one. Workers can publish a brief milestone with `cohall progress --message
"Running tests"`; the task ID is inherited during delegated work.

Questions awaiting answers and completed tasks appear in the sending client's
inbox. This covers queued work and tasks that finish after a wait times out:

```bash
npx -y @akshar5/cohall inbox
npx -y @akshar5/cohall status <task-id>
npx -y @akshar5/cohall inbox ack <task-id>
```

The inbox shows short previews; `status` returns the full result. Acknowledge a
completed task after handling it. Synchronous `delegate` calls acknowledge their
completed results automatically. Questions require an answer or cancellation.
The inbox shows up to 20 oldest entries and sets `hasMore` when more are waiting;
handle entries to reveal the rest.
Each client credential has its own inbox, including
client-only pairings. The relay keeps at most 1,000 completed tasks by default,
so an old unacknowledged result can leave the inbox when history is pruned.
Tasks created before the inbox was added have no inbox entry.

If essential information is missing, a worker can run
`cohall request-input --question 'Which branch should I use?'` and end its turn.
The task becomes `needs_input`, frees the worker slot, and returns the question
as `input_request` in `status` or a waiting command. The original requester or
relay owner answers using its question ID:

```bash
cohall answer <task-id> --request-id <question-id> --message 'Use main.'
cohall wait <task-id> --timeout 1800
```

The same task resumes on the same target with its saved provider session when
available. Answers remain in its resumed prompt after a restart. Upgrade the
relay, requester, and worker first. See [clarification and resume](docs/integrations.md#clarification-and-resume)
for MCP, limits, and worker instructions.

Attach up to two explicit files to a coding task. Each file may be up to 256 KiB.
The target receives them as temporary files and can return up to two files by
writing them to the output directory named in its task prompt. List task files
or download a file using the task ID:

```bash
cohall delegate --target @macbook --attach ./screenshot.png \
  --prompt 'Inspect the screenshot and return a short report file.'
cohall attachments <task-id>
cohall download <task-id> report.txt --output ./report.txt
```

The `delegate` MCP tool accepts `attachment_paths`; `list_task_attachments` and
`download_task_attachment` provide the same retrieval flow. Downloads require a
new destination path and never overwrite a local file. When an input and output
share a name, downloads select the output by default; pass `--direction input`
(or the MCP `direction` argument) to retrieve the input. File bytes remain on the
relay until the task is removed by its configured history limit. Upgrade the
relay and target worker before sending attachments; older workers do not
advertise attachment support. Named Grok Bots do not support file attachments.
If a long result and output files exceed the 1 MiB transfer limit, the task
completes with its text result and a notice that the files were omitted.
Provider text results must fit 128 KiB. Codex and OpenCode JSON events are capped
at 1 MiB each; retained OpenCode message parts use the same bound. If an event
is discarded at that limit, the provider must return
a later complete answer or the task fails explicitly. Identified OpenCode
multipart answers must follow a new message-start event; more parts from the same
message cannot recover discarded content. Older OpenCode events without part IDs
keep their last-text behavior.

`--timeout` accepts 5 to 86400 seconds and defaults to 900. It limits how long
the command waits; the task continues after that. Invalid timeout values are
rejected before any work is sent, including with `--no-wait`.

To stop coding work at a fixed time, pass `--deadline <UTC-ISO-timestamp>` to
`delegate`, or `deadline` to the MCP tool. The future deadline is saved on the
task and stays unchanged through retries and clarification. Expired tasks fail
with `Task deadline exceeded`. Tasks awaiting their first dispatch fail on the
relay. Tasks that may have reached a worker stay `cancelling` until it confirms
termination, including after a disconnect. Upgrade the requester, relay, and
worker before using deadlines. Named Grok Bots do not support them.
See [task deadlines](docs/integrations.md#task-deadlines) for details.

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

For a new computer, follow [Grok Bot setup](docs/grok-bot.md). It covers
Tailscale access, the suggested `tag:grokbot` identity, secure pairing, gateway
configuration, and recovery on hosts without systemd. Pair the computer once;
its Cohall worker discovers every named Bot there. Tailscale policies can
select the computer by its tag; Cohall does not require one.

On an already paired Grok Bot computer, configure its actual gateway file and
restart the Cohall worker:

```bash
test -f "$HOME/agent-data/gateway.json" && test -r "$HOME/agent-data/gateway.json" &&
  cohall configure --grok-gateway "$HOME/agent-data/gateway.json" --providers grok-bot
```

The path is an example; check the file on that computer before using it. Add
`codex` to the provider list only when Codex is installed and signed in there.
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
been dispatched and tasks paused for clarification can be cancelled. Active Bot
turns must be stopped in Grok Bot because
the gateway cannot safely cancel a specific Cohall turn.
A dispatched Bot request remains non-cancellable through Cohall if a disconnect
or relay restart puts it back in the queue, even if its acceptance message was lost.
When upgrading an older relay without dispatch records, outstanding Bot requests
are conservatively treated as potentially dispatched.

Cohall includes a local callback command in each Bot request. After finishing,
the Bot hands its result back by running the supplied command,
`cohall reply <task-id> --run-id <run-id> --message-file <path>`, on its computer.
Preserve the supplied task and run IDs. The callback also accepts `--message -`
for stdin, `--message <text>`, or `--error <text>` when the Bot cannot complete
the task. Use `--question <text>` to ask for essential missing information, then
end the Bot turn; the sender's answer resumes the same task with a new callback.
It records the result locally without relay credentials or transcript scraping.
The task becomes completed when the worker receives this callback; a reply in
the Grok Bot chat alone does not complete it. If no callback arrives within six
hours of that turn's first dispatch, Cohall reports failure. That deadline does not
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
It and `cohall devices` include each device's current queue count and the
creation time of its oldest queued task. Assigned, running, cancelling, and
terminal tasks do not count as queued. Queue fields are absent with older relays.
`usage` reports retained Cohall task activity by device, status, and provider,
including forgotten devices whose tasks are still retained. Provider token counts
and billing are not available to the relay.

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
exact release with `--to 1.2.3`. Updated daemons leave newer installations untouched
when `latest` is older; an exact `--to` version can intentionally roll back.
`cohall upgrades` returns the 50 newest results.
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
  grow without bound. It acknowledges replayed task and upgrade replies after
  pruning so workers can discard local replies; this does not restore deleted
  history.
- Paired clients can ask a device's local provider to act with that user's normal
  authority. Pair only devices and users you trust.
- Workspace roots are enforced after resolving symlinks, credentials are
  role-separated, and task traces omit prompts, results, tokens, and provider
  session IDs. Traces include worker progress and clarification text; inspect
  those fields before sharing them.

## Documentation

- [Installation, pairing, providers, and upgrades](docs/install.md)
- [Grok Bot computer setup, Tailscale, and recovery](docs/grok-bot.md)
- [Agent skill and MCP integrations](docs/integrations.md)
- [Muse requester setup and proxy access](docs/muse.md)
- [Linux, macOS, and Windows services](docs/services.md)
- [Contributing](CONTRIBUTING.md)

Cohall is licensed under the [MIT License](LICENSE).
