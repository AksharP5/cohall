# Install Cohall

Cohall requires Node.js 24 or newer. It is a standard public npm package with no
bundled agent harness.

## Package runners

Use one command. The documentation uses `npx` in later examples.

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

## Global installation for services

An unattended relay or device worker needs a stable executable path. Install it
globally with the package manager that will own the service.

**npm**

```bash
npm install --global @akshar5/cohall
```

**Bun**

```bash
bun add --global @akshar5/cohall
```

**pnpm**

```bash
pnpm add --global @akshar5/cohall
```

Then verify:

```bash
cohall --version
```

## Pair a machine

The relay owner creates a token valid for ten minutes and one exchange:

```bash
read -rsp 'Owner token: ' owner_token; printf '\n'
COHALL_RELAY_URL=https://cohall.example.com \
COHALL_TOKEN="$owner_token" \
npx -y @akshar5/cohall pair --label "Workstation"
unset owner_token
```

Transfer it privately. On the machine being added, provide it through stdin so
it does not appear in process arguments or shell history:

```bash
read -rsp 'Pairing token: ' pairing_token; printf '\n'
printf '%s' "$pairing_token" | npx -y @akshar5/cohall join \
  --relay https://cohall.example.com \
  --name workstation \
  --providers codex \
  --workspace "$HOME/dev"
unset pairing_token
```

Workspace roots must already exist. Cohall resolves them to canonical paths and
rejects delegated work outside them.

For a client that submits work but never runs a device worker:

```bash
npx -y @akshar5/cohall pair --client-only --label "Automation client"
read -rsp 'Pairing token: ' pairing_token; printf '\n'
printf '%s' "$pairing_token" | npx -y @akshar5/cohall join \
  --relay https://cohall.example.com \
  --client-only
unset pairing_token
```

Automation may use a mode-`0600` token file with `join --token-file
/path/to/token`.

## Providers

Target devices advertise provider executables they can find. Authentication is
checked when delegated work starts.

| Provider    | Required command | Session continuation     |
| ----------- | ---------------- | ------------------------ |
| Codex       | `codex`          | `codex exec resume`      |
| Claude Code | `claude`         | `claude --resume`        |
| OpenCode    | `opencode`       | `opencode run --session` |

Limit a device to providers configured for that user:

```bash
cohall configure --providers codex,claude-code
cohall configure --providers auto
```

## Configuration

`cohall config` shows stored configuration without tokens. `cohall configure`
changes the relay URL, device name, workspace roots, providers, model, or Codex
sandbox. `cohall doctor` checks the effective configuration, relay connection,
provider executables, authentication readiness, and versions.

Configuration locations:

- Linux: `${XDG_CONFIG_HOME:-~/.config}/cohall/config.json`
- macOS: `~/Library/Application Support/Cohall/config.json`
- Windows: `%APPDATA%\Cohall\config.json`

Use `COHALL_CONFIG` to override the path. On Unix, Cohall enforces directory mode
`0700` and file mode `0600`.

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
| `COHALL_DEVICE_PROVIDERS`                 | Provider allowlist or `auto`                   |
| `COHALL_DEVICE_WORKSPACES`                | Comma-separated workspace roots                |
| `COHALL_DEVICE_WORKSPACES_JSON`           | JSON workspace roots; supports commas in paths |
| `COHALL_MODEL`                            | Target provider model override                 |
| `COHALL_SANDBOX`                          | Codex sandbox override                         |
| `COHALL_THREAD_ID`                        | Inherited thread for nested delegation         |
| `COHALL_DATA_DIR`                         | Relay database and owner-token directory       |
| `COHALL_RELAY_HOST` / `COHALL_RELAY_PORT` | Relay listener                                 |
| `COHALL_RELAY_ALLOW_REMOTE`               | Explicit non-loopback binding opt-in           |
| `COHALL_HISTORY_TASK_LIMIT`               | Terminal tasks retained; default `1000`        |

The relay must be reachable to submit work or read status. Accepted tasks wait
durably while a target is offline and survive relay restarts when its data
directory is persistent.

## Upgrade

Package runners resolve a current release. Upgrade a global installation and
its active services with:

```bash
cohall upgrade
```

Cohall uses the package manager and global prefix that installed it, verifies
the new version, and restarts only active Cohall services. If a service points
to another global installation, Cohall stops and reports the correct executable
instead of restarting the wrong job.

Use `cohall upgrade --to 1.2.3` for an exact version, `--dry-run` to inspect the
plan, or `--no-restart` to leave services pending a manual restart. Back up a
production relay's data directory before an upgrade because SQLite migrations
run in place.
