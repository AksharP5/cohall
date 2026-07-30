# Cohall

Cohall is one shared room for agents running on your own devices. A Codex thread
on Linux can hand browser research to your signed-in Mac, wait for the result,
and continue working without you moving text between machines.

It is self-hosted, uses the Codex CLI and login already present on each device,
and has no hosted service or required paid infrastructure beyond whatever tools
you already use.

## How it fits together

```text
Codex / Claude Code / OpenCode           Cohall web app
           │ MCP                               │
           └──────────────┬────────────────────┘
                          │ HTTPS / WebSocket
                    Cohall relay (VPS)
                     SQLite + routing
                     ╱              ╲
             Mac device agent    Linux device agent
             local Codex         local Codex
             Chrome / Xcode      repos / Docker
```

The relay is not a lead agent. It is a small durable mailbox and live event
router. Device agents can delegate to each other through the same MCP tools, and
every task and response belongs to a visible Cohall conversation.

## What works

- Durable shared conversations, messages, task state, and provider sessions
- Outbound WebSocket device connections that survive relay reconnects
- Explicit `@device` routing or automatic routing by provider availability
- Codex execution under the target device's local user, login, config, skills,
  MCP servers, browser state, and workspace
- Per-thread, per-device Codex session continuity
- Standard stdio MCP tools for Codex, Claude Code, OpenCode, and other clients
- Responsive Buzz-inspired web interface served directly by the relay
- Workspace allowlists, bearer authentication, cancellation, live progress, and
  offline task queues

## Quick start

Requirements: [Bun](https://bun.sh/) 1.3+ and the Codex CLI on devices that
should execute work.

```bash
git clone https://github.com/AksharP5/cohall.git
cd cohall
bun install
cp .env.example .env
```

Put a random token in `.env`:

```bash
openssl rand -hex 32
```

If `COHALL_TOKEN` is omitted for a local setup, the relay generates one at
`.cohall/token`. The local device daemon finds it automatically; paste the value
from that file into the web app's connection settings.

For a single-machine development setup:

```bash
bun run dev
```

Open `http://127.0.0.1:5173`. The development command starts the relay, one
device daemon for the current machine, and Vite.

For the production-shaped setup:

```bash
bun run build
bun run start:relay
```

The built web interface is then available at `http://127.0.0.1:8787`.

On every Mac, Linux machine, or VPS that should accept work:

```bash
COHALL_RELAY_URL=http://your-relay:8787 \
COHALL_TOKEN=the-same-token \
COHALL_DEVICE_NAME=macbook \
COHALL_DEVICE_WORKSPACES="$HOME/dev,$HOME/.skillsync/repo" \
bun run start:device
```

`COHALL_DEVICE_WORKSPACES` is a comma-separated allowlist. A remote task cannot
choose a working directory outside those roots.

## Add Cohall to Codex

Add this to `~/.codex/config.toml`, using the absolute path to your checkout:

```toml
[mcp_servers.cohall]
command = "bun"
args = ["/absolute/path/to/cohall/apps/device/src/main.ts", "mcp"]

[mcp_servers.cohall.env]
COHALL_RELAY_URL = "http://your-relay:8787"
COHALL_TOKEN = "the-same-token"
COHALL_DEVICE_NAME = "linux"
COHALL_DEVICE_WORKSPACES = "/home/you/dev,/home/you/.skillsync/repo"
```

Restart Codex. It receives five tools:

- `list_devices`
- `delegate`
- `task_status`
- `cancel_task`
- `thread_context`

You can then ask normally:

> Use @macbook to study these YouTube videos in my signed-in browser, then have
> @linux apply the findings to my shared skill.

The host agent chooses the MCP calls. Cohall cannot secretly read the host
client's transcript; like normal MCP servers, it receives the arguments the
agent sends. The `delegate` tool explicitly tells the agent to include the
relevant context and to reuse the returned Cohall thread ID, so you do not copy
anything yourself.

Claude Code and OpenCode can use the same command as a standard stdio MCP
server. The remote device provider implemented today is Codex; the wire protocol
already reserves Claude Code and OpenCode providers for future adapters.

## Put the relay on a VPS

The simplest private deployment is a small VPS already in your Tailscale
network:

```dotenv
COHALL_RELAY_HOST=0.0.0.0
COHALL_RELAY_PORT=8787
COHALL_TOKEN=replace-with-a-long-random-token
COHALL_DATA_DIR=/var/lib/cohall
```

Bind firewall access to the tailnet where possible. Devices only make outbound
connections to the relay; the relay never SSHes into them. See
[`deploy/systemd`](deploy/systemd) for service templates.

## Configuration

| Variable                   | Purpose                                   | Default                           |
| -------------------------- | ----------------------------------------- | --------------------------------- |
| `COHALL_RELAY_HOST`        | Relay bind address                        | `127.0.0.1`                       |
| `COHALL_RELAY_PORT`        | Relay and web port                        | `8787`                            |
| `COHALL_RELAY_URL`         | Relay URL used by devices and MCP         | `http://127.0.0.1:8787`           |
| `COHALL_TOKEN`             | Shared bearer token                       | generated in the data directory   |
| `COHALL_DATA_DIR`          | Relay SQLite directory                    | `.cohall`                         |
| `COHALL_ALLOWED_ORIGINS`   | Extra browser origins, comma-separated    | local Vite origins                |
| `COHALL_DEVICE_NAME`       | Human-readable `@device` name             | hostname                          |
| `COHALL_DEVICE_ID`         | Stable UUID override                      | persisted automatically           |
| `COHALL_DEVICE_STATE`      | Stable ID file                            | `~/.local/state/cohall/device-id` |
| `COHALL_DEVICE_WORKSPACES` | Comma-separated workspace roots           | current directory                 |
| `COHALL_CODEX_MODEL`       | Optional model override                   | local Codex default               |
| `COHALL_CODEX_SANDBOX`     | Optional sandbox override                 | local Codex default               |
| `COHALL_THREAD_ID`         | Cohall thread inherited by an MCP process | unset                             |

Run `bun run doctor` on a device to check relay reachability, workspace
configuration, and the local Codex executable.

## Security model

- Treat the Cohall token like an SSH key and rotate it if exposed.
- Prefer Tailscale, a private network, or TLS in front of a public relay.
- Device agents run with the permissions of the local account that started them.
- The daemon refuses workspaces outside its configured roots.
- Cohall does not upload cookies or browser profiles. Codex uses local tools and
  signed-in state only on the chosen device.
- Non-interactive Codex tasks use `approval_policy="never"` so remote jobs cannot
  stall on a hidden prompt. Set `COHALL_CODEX_SANDBOX` to enforce the sandbox you
  want, or rely on the local Codex default.

## Development

```bash
bun run check
```

The project uses Effect for boundary validation, typed services and errors,
retry schedules, polling, and resource lifetime. The relay edge uses Bun's
native HTTP, WebSocket, and SQLite APIs.

The interface recreates the interaction density of Buzz but does not include
Buzz branding, logos, assets, or copied application code.
