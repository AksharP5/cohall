# Connect Grok Bot

One Cohall worker on the Grok Bot computer discovers all of its existing named
Bots. You pair the computer once, then address individual Bots by name from any
paired device. The Bots keep their Grok conversations, tools, and permissions.

You need a running Cohall relay, Node.js 24 or newer on the Grok Bot computer,
and a way for that computer to reach the relay. Use an HTTPS relay if you have
one. The Tailscale steps below are for a relay reachable only through a tailnet.

## 1. Give the computer access to the relay

`tag:grokbot` is a suggested Tailscale identity for the **computer**, not a tag
that Cohall requires. Tailscale tags replace a device's user identity, so use it
for the Bot computer rather than your personal laptop. The Bot initiates an
outbound connection to the relay. It does not need Tailscale SSH, an exit node,
subnet routes, or an inbound grant. [Tailscale's tag guide](https://tailscale.com/docs/features/tags)
explains tag ownership and device identity.

The relay must listen on its Tailscale address and port, not only on
`127.0.0.1`. Follow [Linux relay setup](services.md#linux-relay) if it is still
local-only. Keep the listener private.

In the Tailscale admin console's **Access controls**, add these entries to your
existing policy. Replace the example IP and port with your relay's Tailscale IP
and listening port. Keep the rest of your policy:

```jsonc
{
  "tagOwners": {
    "tag:grokbot": ["autogroup:admin"],
  },
  "grants": [
    {
      "src": ["tag:grokbot"],
      "dst": ["100.101.102.103"],
      "ip": ["tcp:8787"],
    },
  ],
}
```

This grant allows tagged computers to initiate TCP connections to that relay
port. Tailscale combines grants, so check existing broader rules if you want
this to be the computer's only tailnet access. See the
[grants syntax](https://tailscale.com/docs/reference/syntax/grants).

For a new Tailscale device, create a **one-off, non-ephemeral** auth key with
`tag:grokbot` selected under **Keys** in the Tailscale admin console. Give that
key to the Grok Bot computer through a masked secret input or a mode-`0600`
temporary file. Never paste it into an ordinary Bot chat or a shell command
argument. The Tailscale CLI accepts `--auth-key=file:/path/to/key`; remove the
temporary file after joining. A tagged key applies the tag when the device
joins. If the computer is already on your tailnet, an admin can instead add
`tag:grokbot` under **Machines > Edit tags** without creating a new key.
[Tailscale's auth key guide](https://tailscale.com/docs/features/access-control/auth-keys)
covers both one-off keys and tagged devices.

On the Bot computer, verify that Tailscale is connected and that the relay
responds:

```bash
tailscale status
curl -fsS http://100.101.102.103:8787/api/health
```

Replace the example address again. Check the computer's `tag:grokbot` identity
on the Tailscale **Machines** page. A successful `curl` proves the route works;
it does not by itself prove which grant allowed it.

## 2. Pair the computer with Cohall

On the **relay owner account**, create a Cohall full-worker pairing token:

```bash
cohall pair --label "Grok Bot computer"
```

The token lasts ten minutes and works once. Transfer it through a masked secret
input or a private channel, not the ordinary Bot chat. On the Grok Bot computer,
install Cohall globally and pair it. Replace the relay URL and workspace with
your actual values:

```bash
npm install --global --prefix "$HOME/.local" @akshar5/cohall
"$HOME/.local/bin/cohall" --version
"$HOME/.local/bin/cohall" init \
  --relay http://100.101.102.103:8787 \
  --name grokbot \
  --workspace /workspace \
  --providers grok-bot
```

Run `init` in an interactive terminal for its masked pairing-token prompt. For
an agent-run setup without an interactive terminal, put the token in a private
mode-`0600` file and pass `--token-file /path/to/token`; delete the file after
pairing. Do not put the token in command arguments or logs. Use an HTTPS URL
instead if your relay is exposed through HTTPS. The workspace must exist; native
Bot tasks use the Bot's own computer permissions rather than this workspace
root, but Codex tasks need a valid root.

## 3. Connect the local Grok Bot gateway

Find the gateway discovery file on **that computer**. On current Grok Bot
computers it may be at `$HOME/agent-data/gateway.json`; use the actual path if
different. The file contains a local gateway credential, so check that it is
readable without printing or copying its contents:

```bash
test -r "$HOME/agent-data/gateway.json" && "$HOME/.local/bin/cohall" configure \
  --grok-gateway "$HOME/agent-data/gateway.json" \
  --providers grok-bot
```

If the file check fails, find the discovery file used by this Grok Bot
installation and substitute its path.

If Codex is also installed and signed in **on the Bot computer**, use
`--providers codex,grok-bot` so Bots can delegate coding to that local Codex.
Cohall does not transfer a Codex login, GitHub login, or skills from another
computer. The gateway credential stays on the Bot computer; Cohall advertises
the discovered Bot names through its relay.

Start one Cohall worker and keep it running. Restart an existing worker after
changing its providers or gateway path. On a computer with systemd, use
`cohall service install`. Grok Bot cloud computers may have no systemd, so use
the computer's supported supervisor or recurring routine to start the worker
and Tailscale again after processes stop. Keep Cohall configuration and the
Tailscale node state on persistent storage. A computer update may remove
installed packages and stop processes even when its home files survive; the
recovery routine must reinstall missing programs and restart exactly one copy
of each worker. An hourly routine can restore availability after an update,
but does not keep a suspended computer awake or guarantee an immediate restart.
See [service behavior](services.md#startup-behavior).

Verify on the Bot computer:

```bash
"$HOME/.local/bin/cohall" doctor
"$HOME/.local/bin/cohall" bots
```

`doctor` should report the relay and local gateway reachable, no warnings, and
the worker online. `bots` should list all discovered Bots, not just the one
that helped with setup. From another paired device:

```bash
cohall bots
cohall send '@yt desk' 'Give me three video ideas.'
cohall send --thread <returned-thread-id> 'Expand the second idea.'
```

Bot names with spaces need quotes. If a name appears on more than one computer,
use the full target shown by `cohall bots`. A Bot can delegate to Codex on the
same computer:

```bash
cohall delegate --target @grokbot --provider codex \
  --parent <parent-task-id> --thread <thread-id> \
  --prompt 'Concrete task'
```

See [Bot replies and cancellation](../README.md#talk-to-your-grok-bots) for
how Cohall records the answer. The local gateway is experimental and may change
with Grok Bot updates.

## Give the setup to a Bot

Once you have added the Tailscale policy, you can send this to a Bot on the
computer. Replace the example relay URL before sending it. Create each one-off
key only when the Bot asks for it, so the Cohall pairing token does not expire
while Tailscale is being installed.

```text
Set up Cohall on this Grok Bot computer using the current docs/grok-bot.md in
https://github.com/AksharP5/cohall. My relay URL is
http://100.101.102.103:8787. The workspace is /workspace.

Install the official Tailscale package and join my tailnet with a one-off,
non-ephemeral key tagged tag:grokbot. Pause for the key through a masked secret
input. Never ask me to paste a secret into ordinary chat, and keep it out of
command arguments, logs, and history. Verify the tag and relay reachability.

Ensure Node.js 24 or newer is available. Then install Cohall globally. Ask for
a separate one-time Cohall full-worker pairing token through secure input and
pair this computer. Find the local Grok Bot gateway discovery file without
printing its contents. Configure the
grok-bot provider. Include Codex only if its CLI is installed and signed in
here. Start exactly one worker and verify cohall doctor and cohall bots.

Use this computer's supported supervisor or routine for recovery if systemd
is absent. Preserve pairing, gateway configuration, Tailscale identity, and
home state. Report what restarts automatically, what survives a computer
update, and anything I must do manually. Do not claim the worker is always on
if the host stops it between routines.
```
