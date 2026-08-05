# Run Cohall as a service

Interactive use should use `npx -y @akshar5/cohall`. Unattended services
install the same npm package so the operating system has a stable executable
path.

## Linux device daemon

Install and pair as the user that will run the daemon:

```bash
npm install --global --prefix "$HOME/.local" @akshar5/cohall
npx -y @akshar5/cohall doctor
```

Copy `deploy/systemd/cohall-device.service` to
`~/.config/systemd/user/cohall-device.service`, then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now cohall-device
journalctl --user -u cohall-device -f
loginctl enable-linger "$USER"
```

Linger is optional; it keeps the daemon running after logout.

## Linux relay

Create a dedicated `cohall` user, install the npm package globally so
`command -v cohall` returns `/usr/local/bin/cohall`, and place the relay
environment at `/etc/cohall/relay.env` with mode `0600`:

```dotenv
COHALL_RELAY_HOST=0.0.0.0
COHALL_RELAY_PORT=8787
COHALL_RELAY_ALLOW_REMOTE=true
COHALL_TOKEN=replace-with-a-random-owner-token
COHALL_DATA_DIR=/var/lib/cohall
```

Install `deploy/systemd/cohall-relay.service`, then:

```bash
systemctl daemon-reload
systemctl enable --now cohall-relay
journalctl -u cohall-relay -f
```

Expose the relay only through a private network such as Tailscale or an HTTPS
reverse proxy. Device connections are outbound WebSockets.

## macOS

Run `npm install --global @akshar5/cohall`, then update the executable path in
`deploy/launchd/com.cohall.device.plist` to match `command -v cohall`. Copy the
plist to `~/Library/LaunchAgents/`, then load it:

```bash
launchctl bootstrap gui/"$(id -u)" ~/Library/LaunchAgents/com.cohall.device.plist
launchctl kickstart -k gui/"$(id -u)"/com.cohall.device
```

## Windows

Run `npm install --global @akshar5/cohall`, pair and verify the machine from
PowerShell, then run:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\install-device.ps1
```

The script registers a per-user scheduled task that starts `cohall device` at
logon and restarts it after failures.
