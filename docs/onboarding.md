# Set up Cohall with your agent

These instructions are for the agent doing the setup. Read the path that matches
the owner's request, complete the verification steps, and report what works.
`cohall onboard` prints this same guide without changing the machine.

## Choose the role

- A relay address and pairing token mean **join an existing relay**.
- A request to host a relay means **host a relay** on an always-on machine.
- If neither is clear, ask whether this machine should host or join, and obtain
  the relay address before pairing. A laptop that sleeps is a poor relay host.
- For an existing installation, inspect `cohall config` and run `cohall doctor`
  before repairing it. Reuse working credentials and workspace settings.

Detect the OS, Node.js version, package manager, installed provider CLIs, and
existing workspace roots. Cohall requires Node.js 24 or newer. Follow
[installation](https://github.com/AksharP5/cohall/blob/main/docs/install.md) for package commands and
[services](https://github.com/AksharP5/cohall/blob/main/docs/services.md) for the current OS. Use the owner's authorization for
installation and autostart; obtain it when missing. Provider login requires the
owner's account and should stay on the machine that runs that provider.

Keep tokens out of command arguments, shell history, logs, and setup briefs.
Read them through a hidden terminal prompt, stdin, or a private token file.

## Host a relay

1. Choose a machine that stays awake and a persistent relay data directory.
   Install Cohall globally so its service has a stable executable path.
2. Start `cohall relay` once in the foreground. The default listener is
   `127.0.0.1:8787`; the relay creates a private owner token in its data directory
   when none is supplied. Preserve that directory and include it in backups.
3. Make the relay reachable through the owner's private Tailscale network or
   HTTPS reverse proxy. Confirm the address from a joining machine with
   `GET /api/health`. Plain HTTP is suitable only inside an independently
   encrypted private network, never as a public listener.
4. Configure relay autostart. The packaged relay service instructions cover
   Linux; macOS and Windows relay hosts need an owner-approved supervisor.
   `cohall service install` installs a **device worker**, not a relay.
   Prepare the managed relay with the same data and owner configuration. Stop
   the foreground relay to release its address, start the managed service, and
   verify relay health before pairing devices.
5. On the relay host, create a ten-minute, single-use pairing token for each
   joining machine:

   ```bash
   cohall pair --label "Workstation"
   ```

   Set `COHALL_RELAY_URL` to the reachable address when creating the pairing so
   its `join_instructions` use that address. The owner token is read from the
   relay data directory on the host; a service using a different user or data
   directory needs the matching owner configuration. Transfer the pairing token
   privately and send the returned join instructions separately.

6. If this host should also run agent work, pair it as another device and
   complete the joining path below. Hosting a relay alone does not register a
   worker or install its agent integration.

## Join an existing relay

1. Confirm the relay address and the role. A worker runs providers against its
   own allowed workspaces; a client-only installation submits work elsewhere.
   Request a fresh token if the supplied one has expired or was already used.
2. Choose existing workspace roots and installed providers for a worker.
   Confirm provider login on this machine. Use `--providers codex`,
   `--providers claude-code`, or `--providers opencode` to limit selection;
   `auto` enables every detected provider. Grok Bots have a separate
   [gateway setup](https://github.com/AksharP5/cohall/blob/main/docs/grok-bot.md).
3. Run guided setup with the confirmed address:

   ```bash
   cohall init --relay https://your-relay.example
   ```

   A terminal prompts for the pairing token without echoing it. Scripts and
   agents without an interactive terminal supply it on stdin or with
   `--token-file`; see the [pairing examples](https://github.com/AksharP5/cohall/blob/main/docs/install.md#pair-a-machine).
   Client-only setup adds `--client-only` and uses a client-only pairing.
   `init` writes configuration and installs the Cohall skill for Codex,
   Claude Code, and OpenCode. It preserves existing settings during repair.

4. For a worker, run `cohall device` in the foreground or install its service
   after a global package installation. `cohall init --service` can install the
   worker service during setup. A client-only installation needs no device
   service. For Grok Bots, use the gateway instructions to verify availability.
5. Use the CLI and installed skill in a harness that can run commands. If the
   owner prefers MCP, run `cohall integrations` and follow the entry for the
   actual harness in [agent integrations](https://github.com/AksharP5/cohall/blob/main/docs/integrations.md). Configure exactly
   one Cohall server for that configuration, restart or reconnect the harness,
   and ask it to call `list_devices`. Installing a skill does not configure MCP.

## Verify before calling setup complete

1. Run `cohall doctor`. Confirm relay access and client authentication. A worker
   should be online or busy with the intended providers and workspaces.
   `doctor --all` checks the other registered workers.
2. If using MCP, check the real host connection in the doctor report after
   asking the harness to call `list_devices`. A successful server self-test
   alone does not establish that the harness loaded it.
3. From the requesting client, run a harmless delegation to the intended
   worker, using its target from `cohall devices` and an advertised provider:

   ```bash
   cohall delegate --target @workstation --provider codex --timeout 60 \
     "Reply with exactly cohall-ready. Do not inspect or change files."
   ```

   Require a completed result containing `cohall-ready`. Provider detection
   alone does not prove authentication or execution works. For a Grok Bot,
   use its target from `cohall bots` and `--provider grok-bot`.

4. Report the relay host/address, this machine's role, selected providers and
   workspaces, autostart state, integration used, and checks that passed.
   Identify any remaining login, permission, or connectivity step. Include no
   tokens or private task content.
