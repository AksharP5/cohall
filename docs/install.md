# Install Cohall

Cohall requires Node.js 24 or newer. It is a standard public npm package with no
bundled agent harness.

For agent-led setup, follow [onboarding](onboarding.md) or run
`npx -y @akshar5/cohall onboard`. It separates hosting a relay from joining one
and ends with a real delegation check.

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

Transfer it privately. On the machine being added, `cohall init` collects any
missing values interactively, exchanges the pairing token, writes the
configuration, and installs the Cohall skill. Provide the token through stdin
so it does not appear in process arguments or shell history:

```bash
read -rsp 'Pairing token: ' pairing_token; printf '\n'
printf '%s' "$pairing_token" | npx -y @akshar5/cohall init \
  --relay https://cohall.example.com \
  --name workstation \
  --providers codex \
  --workspace "$HOME/dev"
unset pairing_token
```

Pairing also returns `join_instructions`: a copyable agent setup brief for the
selected role and relay. It contains no pairing token; transfer that separately.

When run in a terminal, omitted relay, name, workspace, provider, and token
values are prompted. A fresh setup validates the relay URL and provider selection
before reading a pairing token. A device `join` also requires at least one
workspace first.
`init` and `join` reuse a saved address but never assume a local relay for a new
installation. Re-running `cohall init` repairs the
skill installation and reuses credentials when the selected relay has not
changed. Keeping the default workspace retains all configured roots;
`init --client-only` and `join --client-only` retain worker settings without
revalidating unused workspace directories. Explicit `join --workspace` changes
still require existing directories; `--providers` can override the provider selection. An explicit
`--token-file` requests a new pairing exchange even when credentials are saved.
`cohall join` remains the non-guided configuration primitive.
`--client-only` and `--service` cannot be combined.

Worker setup requires existing workspace directories. Cohall resolves them to canonical paths and
rejects delegated work outside them.

For a client that submits work but never runs a device worker:

```bash
npx -y @akshar5/cohall pair --client-only --label "Automation client"
read -rsp 'Pairing token: ' pairing_token; printf '\n'
printf '%s' "$pairing_token" | npx -y @akshar5/cohall init \
  --relay https://cohall.example.com \
  --client-only
unset pairing_token
```

Automation may use a mode-`0600` token file with `join --token-file
/path/to/token`.

## Keep a device available

After a global installation, install and start the current user's device
service with one command:

```bash
cohall service install
cohall doctor
```

Linux uses a systemd user service, macOS uses a LaunchAgent, and Windows uses a
per-user scheduled task. The installer records the exact global Cohall
executable, so it refuses temporary package-runner and source-checkout paths.

## Providers

Target devices advertise installed coding providers. Authentication is checked
when delegated work starts.

| Provider    | Required command | Session continuation     |
| ----------- | ---------------- | ------------------------ |
| Codex       | `codex`          | `codex exec resume`      |
| Claude Code | `claude`         | `claude --resume`        |
| OpenCode    | `opencode`       | `opencode run --session` |

The experimental `grok-bot` provider connects to named Bots through their
computer's local gateway. Follow [Grok Bot computer setup](grok-bot.md) for
Tailscale access, pairing, provider configuration, and recovery. A worker
configured with `--providers grok-bot` advertises all Bots found by that
gateway. Add `codex` only when its CLI is installed and signed in on that
computer. Bot model selection and permissions remain with Grok Bot.

Limit a device to providers configured for that user:

```bash
cohall configure --providers codex,claude-code
cohall configure --providers auto
```

Restart the worker after changing its provider selection. Queued work for a
disabled provider fails with an error instead of starting that provider.
`auto` enables all detected providers.

## Configuration

`cohall config` shows stored configuration without tokens. `cohall configure`
changes the device name, workspace roots, providers, Grok gateway path, model, sandbox, or relay
for a fresh pairing. Use `cohall relay use <url>` when moving an existing relay;
it preserves credentials only after verifying them at the restored address.
Non-loopback HTTP is refused unless `--allow-http` explicitly confirms that an
independent private network such as Tailscale encrypts the connection.
`cohall doctor` checks the effective configuration, relay connection, provider
executables, authentication readiness, and versions. With a client credential,
it also runs a local MCP server self-test and separately reports observed agent
host connections. The self-test lists tools without calling one or requiring
the relay. To verify your harness, ask it to call `list_devices` and inspect
`mcp_host` using the same config path; see [MCP host verification](integrations.md#verify-the-mcp-host).

Configuration locations:

- Linux: `${XDG_CONFIG_HOME:-~/.config}/cohall/config.json`
- macOS: `~/Library/Application Support/Cohall/config.json`
- Windows: `%APPDATA%\Cohall\config.json`

Use `COHALL_CONFIG` to override the path. On Unix, Cohall enforces directory mode
`0700` and file mode `0600`.

On Linux, `XDG_CONFIG_HOME` and `XDG_DATA_HOME` must be absolute paths. Empty or
relative values use `~/.config` and `~/.local/share` instead. Relay data defaults
to the `cohall` directory under `XDG_DATA_HOME`; `COHALL_DATA_DIR` overrides it.

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
| `COHALL_TASK_ID`                          | Inherited parent task for nested delegation    |
| `COHALL_GROK_GATEWAY`                     | Local Grok Bot gateway discovery file          |
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

Upgrades and device service installation require a verified global installation.
Project dependencies and package-runner caches are rejected before making changes.
For npm, the global `cohall` command must still point to this installation.
For Bun, Cohall checks the selected Bun executable's configured global directory,
including custom `install.globalDir` or `BUN_INSTALL_GLOBAL_DIR` settings, and pins
installation to that directory. Use the same Bun configuration when invoking
Cohall; a different global directory is rejected.

The default target, `latest`, is resolved through that package manager using its
registry and network settings, then pinned before installation. Bun installations
require Bun 1.2.15 or newer for this lookup; older Bun versions can still use an
exact `--to` version. If `latest` is older than the running or installed version,
Cohall leaves the installation and services untouched. Version ordering includes
prereleases and ignores build metadata. A failed or invalid lookup, or unreadable
installed package metadata, stops the upgrade before installation. Use an exact
`--to` version to repair damaged metadata.

Use `cohall upgrade --to 1.2.3` for an exact version, including an intentional
rollback. Use `--dry-run` to inspect the plan, or `--no-restart` to leave services
pending a manual restart. Back up a
production relay's data directory before an upgrade because SQLite migrations
run in place.

An exact version already installed on disk skips package installation and still
restarts active services. Dry runs and failed installations preserve restart
recovery state. A new explicit version takes precedence over an older recovery
record, while retaining unfinished restarts for the new version. `--no-restart`
also preserves pending restarts for a later retry. A later
`cohall upgrade --no-restart` still checks the latest release and carries those
pending restarts forward if another version is installed.

Upgrade tools use the first PATH candidate that passes ownership and permission
checks. Unsafe candidates are skipped; an explicit executable path must pass
those checks itself. Linux user namespaces may hide root ownership of fixed OS
directories, but user-installed executables still require trusted ownership and
permissions.

The relay owner can queue the same built-in upgrade across every registered
device:

```bash
cohall upgrade --all --dry-run
cohall upgrade --all --to 1.2.3
cohall upgrades
cohall upgrades abandon <operation-id>
```

All-device upgrades require the relay owner credential. They are stored by the
relay, wait for offline devices, and run after active tasks. `cohall upgrades`
shows the 50 newest queued, running, completed, or failed results. A `latest`
operation applies the same downgrade check on each device when it executes;
upgrade older daemons individually once to gain this protection. Upgrade devices
older than Cohall 0.5.0 individually once before using all-device upgrades; the
relay rejects work that their daemons cannot understand. If a device is permanently
lost, the owner can abandon its operation so later all-device upgrades are not
blocked. Abandonment records a failed terminal result; it does not stop an upgrade
already executing on a reachable device. Forgetting an offline device also closes
its outstanding maintenance operation. The operation accepts only `latest` or an
exact semantic version and invokes Cohall's existing package upgrade path; it
cannot transport arbitrary commands. Devices running from a temporary package
runner report a failure until Cohall is installed globally on that device.

Use `cohall doctor --all` for device health and version drift, `cohall versions`
for a compact version inventory, and `cohall usage` for retained task counts by
device, status, and provider. Usage is Cohall task activity, not provider token
or billing data.
