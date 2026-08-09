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
cohall doctor
```

Install and start the current user's service:

```bash
cohall service install
journalctl --user -u cohall-device -f
```

The generated service uses the exact executable that ran the installer. Linger
is optional. Without it, the user service starts after login and stops with the
user's service manager. With it, the service starts at boot and remains after
logout:

```bash
loginctl enable-linger "$USER"
```

Verify the configuration with:

```bash
systemctl --user is-enabled cohall-device
systemctl --user is-active cohall-device
loginctl show-user "$USER" -p Linger
```

## Linux relay

Create a dedicated `cohall` user, install the npm package globally so
`command -v cohall` returns `/usr/local/bin/cohall`, and place the relay
environment at `/etc/cohall/relay.env` with mode `0600`. Generate the token with
`openssl rand -hex 32`; do not use the placeholder literally.

```dotenv
COHALL_RELAY_HOST=0.0.0.0
COHALL_RELAY_PORT=8787
COHALL_RELAY_ALLOW_REMOTE=true
COHALL_TOKEN=replace-with-the-output-of-openssl-rand-hex-32
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

## Move a relay

A relay's SQLite database and owner credential are its portable state. Cohall
can take a consistent backup while the old relay is running:

```bash
cohall relay backup ./cohall-relay-backup
```

Run that command with the same `COHALL_DATA_DIR` and operating-system account
as the relay service. Copy the resulting directory to the new host over a
private channel. It contains credentials, pairings, task results, thread
history, and provider session references.

On the new host, install Cohall and restore into the new service's data
directory before starting it:

```bash
COHALL_DATA_DIR=/var/lib/cohall cohall relay restore ./cohall-relay-backup
```

The target data directory must not already exist. Restore refuses to overwrite
one, verifies file checksums and SQLite integrity, and publishes the restored
directory atomically. Run the command as the service account so the resulting
files have the correct owner. The restored `owner-token` file supplies the
owner credential when `COHALL_TOKEN` is unset; if the new service explicitly
sets that variable, it must use the same value.

Configure the private network or HTTPS endpoint, start the relay, and check its
health. If its address changed, update every client and device:

```bash
cohall relay use https://new-relay.example.com
cohall doctor
```

`relay use` first proves that every stored client and device credential works
against the new relay. Only then does it save the address. It restarts an
active managed device service automatically; use `--no-restart` when another
supervisor owns the process. Environment-based configurations must update
`COHALL_RELAY_URL` in their service environment instead.

Keeping the same stable DNS or Tailscale name avoids the final per-device step.
Only change where that name resolves after the restored relay is healthy.

## macOS

Run `npm install --global @akshar5/cohall`, then install and start the
LaunchAgent:

```bash
cohall service install
```

The generated LaunchAgent uses `RunAtLoad` and `KeepAlive`: it starts at login,
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
cohall service install
```

The script registers a per-user scheduled task that starts `cohall device` at
logon and restarts it after failures. It does not run before that user logs on.

## Upgrade running services

Run `cohall upgrade` from a global npm, Bun, or pnpm installation. It updates
that installation and restarts only active managed Cohall services, with relays
restarted before device workers. Active services restart even when the installed
files already match the requested version. Socket-activated relays keep accepting
new connections while their process is replaced, and delegated upgrades finish
through durable restart recovery.

Before changing files, Cohall verifies that active systemd and launchd jobs use
the same global installation as the invoked CLI. If they differ, use the
executable named in the error or update the service definition.

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
