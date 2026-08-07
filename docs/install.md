# Install Cohall

## Run with a package runner

Cohall is a public npm package and requires Node.js 24 or newer. Nothing from
Buzz, T3Code, Codex, Claude Code, or OpenCode is bundled or required.

```bash
npx -y @akshar5/cohall --version
bunx @akshar5/cohall --version
pnpm dlx @akshar5/cohall --version
yarn dlx @akshar5/cohall --version
```

The package follows the standard npm package format, so npm, Bun, pnpm, and Yarn
can install it too. The documentation uses `npx` as the common default. An
unattended relay or device service may install the package globally so its
executable path remains fixed across restarts:

```bash
npm install --global @akshar5/cohall
# or: bun add --global @akshar5/cohall
# or: pnpm add --global @akshar5/cohall
cohall --version
```

## Pair a machine

The relay owner creates a token valid for ten minutes and one exchange:

```bash
COHALL_RELAY_URL=https://cohall.example.com \
COHALL_TOKEN=owner-token \
npx -y @akshar5/cohall pair --label "Linux workstation"
```

Transfer it privately, then enter it without placing it in process arguments or
shell history:

```bash
read -rsp 'Pairing token: ' pairing_token; printf '\n'
printf '%s' "$pairing_token" | npx -y @akshar5/cohall join \
  --relay https://cohall.example.com \
  --name linux \
  --providers codex \
  --workspace "$HOME/dev"
unset pairing_token
```

For a client-only machine that submits work but never runs a device daemon:

```bash
npx -y @akshar5/cohall pair --client-only --label "Automation client"
read -rsp 'Pairing token: ' pairing_token; printf '\n'
printf '%s' "$pairing_token" | npx -y @akshar5/cohall join \
  --relay https://cohall.example.com \
  --client-only
unset pairing_token
```

For automation, place the token in a mode-`0600` file and use
`npx -y @akshar5/cohall join --token-file /path/to/token`. Pairing tokens expire
after ten minutes and can be exchanged once.

Configuration locations:

- Linux: `${XDG_CONFIG_HOME:-~/.config}/cohall/config.json`
- macOS: `~/Library/Application Support/Cohall/config.json`
- Windows: `%APPDATA%\Cohall\config.json`

Use `COHALL_CONFIG` to override the path. On Unix, Cohall enforces directory
mode `0700` and file mode `0600`.

The relay must stay online so devices and clients can reach it. A target device
must be online only while it is accepting or running work; queued tasks remain
durable on the relay while it is offline.

`--providers` is an optional comma-separated allowlist. It prevents an installed
but unauthenticated provider executable from being advertised. Run `cohall
configure --providers auto` to return to executable auto-detection.

## Upgrade

Package runners such as `npx`, `bunx`, and `pnpm dlx` already resolve a current
release. Upgrade a global installation and its running services with:

```bash
cohall upgrade
```

Cohall uses the package manager and global prefix that installed it, verifies
the installed version, then restarts only active Cohall relay and device
services. Active services restart even when the package files are already
current, so a process left on old code by a direct package-manager update is
replaced. Choose an exact version with `cohall upgrade --to 1.2.3`. Use `--dry-run` to inspect the plan or
`--no-restart` to leave active services pending a manual restart.

Back up the data directory before upgrading a production relay; SQLite schema
migrations run in place. A system-level relay may require running the command
with the same privileges used to install and manage that service.
