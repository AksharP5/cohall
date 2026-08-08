# Run Cohall as a service

Interactive use should use `npx -y @akshar5/cohall`. Unattended services
install the same npm package so the operating system has a stable executable
path.

## Startup behavior

| Component      | Starts again                                                                     | Offline behavior                                                         |
| -------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Linux relay    | At boot when its systemd socket and service are enabled                          | Cannot accept new tasks while down; persisted tasks resume after startup |
| Linux device   | With the user's systemd manager; at boot without login when lingering is enabled | Accepted tasks wait on the relay and dispatch after reconnect            |
| macOS device   | At user login through launchd                                                    | Accepted tasks wait while the Mac is off, asleep, or logged out          |
| Windows device | At user logon through Task Scheduler                                             | Accepted tasks wait while the PC is off or logged out                    |

The relay's data directory must be persistent. Cohall uses at-least-once delivery:
work interrupted during execution can run again after recovery, so consequential
tasks should be idempotent.

## Linux device daemon

Install and pair as the user that will run the daemon:

```bash
npm install --global --prefix "$HOME/.local" @akshar5/cohall
npx -y @akshar5/cohall doctor
```

Copy the service shipped in the globally installed package, then start it:

```bash
package_root="$(npm root --global --prefix "$HOME/.local")/@akshar5/cohall"
install -Dm644 "$package_root/deploy/systemd/cohall-device.service" \
  "$HOME/.config/systemd/user/cohall-device.service"
systemctl --user daemon-reload
systemctl --user enable --now cohall-device
journalctl --user -u cohall-device -f
loginctl enable-linger "$USER"
```

Linger is optional. Without it, the user service starts after login and stops
with the user's service manager. With it, the service starts at boot and remains
available after logout. Verify the configuration with:

```bash
systemctl --user is-enabled cohall-device
systemctl --user is-active cohall-device
loginctl show-user "$USER" -p Linger
```

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

Install `deploy/systemd/cohall-relay.service` and
`deploy/systemd/cohall-relay.socket`. The packaged socket listens on loopback;
change `ListenStream` to the relay's private Tailscale address when devices
connect directly over Tailscale. Then:

```bash
systemctl daemon-reload
systemctl enable --now cohall-relay.socket
systemctl enable --now cohall-relay
journalctl -u cohall-relay -f
```

Verify both units are enabled and active:

```bash
systemctl is-enabled cohall-relay.socket cohall-relay.service
systemctl is-active cohall-relay.socket cohall-relay.service
```

Expose the relay only through a private network such as Tailscale or an HTTPS
reverse proxy. Device connections are outbound WebSockets. The socket unit keeps
the listener available across relay service restarts: new connections wait for
the replacement process instead of failing. Existing WebSockets reconnect, and
durable tasks resume after the replacement relay starts.

## macOS

Run `npm install --global @akshar5/cohall`, copy the packaged launch agent, then
update its executable path to match `command -v cohall`:

```bash
package_root="$(npm root --global)/@akshar5/cohall"
mkdir -p "$HOME/Library/LaunchAgents"
cp "$package_root/deploy/launchd/com.cohall.device.plist" \
  "$HOME/Library/LaunchAgents/com.cohall.device.plist"
cohall_path="$(command -v cohall)"
/usr/libexec/PlistBuddy -c "Set :ProgramArguments:0 $cohall_path" \
  "$HOME/Library/LaunchAgents/com.cohall.device.plist"
launchctl bootstrap gui/"$(id -u)" ~/Library/LaunchAgents/com.cohall.device.plist
launchctl kickstart -k gui/"$(id -u)"/com.cohall.device
```

The packaged LaunchAgent uses `RunAtLoad` and `KeepAlive`: it starts at login,
restarts after failure, and reconnects when the network returns. It cannot run
before that user logs in. Check it with:

```bash
launchctl print gui/"$(id -u)"/com.cohall.device
```

The relay and device worker may run on the same machine. Configure the worker
with the relay's private Tailscale URL and install both services independently.

## Windows

Run `npm install --global @akshar5/cohall`, pair and verify the machine from
PowerShell, then run:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\install-device.ps1
```

The script registers a per-user scheduled task that starts `cohall device` at
logon and restarts it after failures. It does not run before that user logs on.

## Upgrade running services

Run `cohall upgrade` from a global npm, Bun, or pnpm installation. It updates
that installation and restarts only active managed Cohall services, with relays
restarted before device daemons. Active services restart even when the installed
files already match the requested version. A systemd relay installed with the
packaged socket unit keeps accepting new connections while its process restarts.
A delegated upgrade can finish after
restarting its own device daemon: a durable receipt records the restart attempt,
and a delegated caller leaves that marker for the replacement task to consume
after reconnecting, even when a service manager returns before ending the old process.
Before changing files, Cohall verifies that active systemd and launchd jobs use
the same global installation as the invoked CLI. If they differ, run the
executable named in the error or update the service definition first.

Direct `npm install --global`, `bun add --global`, or `pnpm add --global`
replaces files on disk but cannot replace code already loaded by a running Node
process. Use `cohall upgrade`, or restart the service manager job manually, to
move a running relay or device to the new version.

## Troubleshooting

Start with `cohall doctor`. It reports relay reachability, device connectivity,
provider selection, executable discovery, and version information without
printing credentials.

Inspect a task's redacted lifecycle, including dispatches, reconnect-driven
requeues, execution, cancellation, and completion:

```bash
cohall trace <task-id>
cohall trace <task-id> --follow
```

Use `journalctl --user -u cohall-device -f` for a Linux device and
`journalctl -u cohall-relay -f` for a system relay. The trace is durable and
portable; service logs remain machine-local.
