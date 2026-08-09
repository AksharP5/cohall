# Cohall

Cohall lets agents on your own devices delegate work to each other. It is a
headless bridge, not another agent app: keep using any harness that can run a
command or connect to a stdio MCP server.

One npm package provides a durable self-hosted relay, outbound-only device
workers, a CLI, an installable agent skill, an optional MCP server, and local
Codex, Claude Code, and OpenCode adapters.

## How it works

```text
Current agent
CLI + skill or MCP
       |
   HTTPS / WSS
       |
Cohall relay + SQLite
     /        \
 Mac agent   Linux agent
 Xcode       Docker
 browser     repositories
```

The relay stores tasks, results, thread history, and provider session IDs. Each
device uses its own files, provider login, tools, skills, permissions, and
signed-in services. Cohall does not copy credentials or remotely control the
machine.

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

Transfer the token privately. On the device being added:

```bash
read -rsp 'Pairing token: ' pairing_token; printf '\n'
printf '%s' "$pairing_token" | npx -y @akshar5/cohall join \
  --relay https://cohall.example.com \
  --name macbook \
  --providers codex \
  --workspace "$HOME/dev"
unset pairing_token
```

### 3. Install the skill and connect

```bash
npx -y @akshar5/cohall skill install all
npx -y @akshar5/cohall doctor
npx -y @akshar5/cohall device
```

Use an operating-system service for an unattended relay or device worker. See
[service setup](docs/services.md).

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

Reuse the returned `thread_id` for follow-ups so the target resumes its provider
session.

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
