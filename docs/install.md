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

## Upgrade

`npx -y @akshar5/cohall` resolves the current npm release. For a globally
installed service, stop it, run `npm install --global @akshar5/cohall@latest`,
verify `cohall doctor`, and restart it. Back up the relay data directory before
upgrading a production relay; SQLite schema migrations run in place.
