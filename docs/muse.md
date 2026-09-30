# Muse requester setup

Muse can submit tasks to Cohall from a sandbox with shell access, Node.js 24 or
newer, and an approved network route to your relay. Pair it as a client-only
requester. Your existing Cohall device workers run the delegated work.

The requester commands have been verified through an authenticated proxy.
The hosted Muse integration has not been tested end to end.

Cohall has no Muse worker adapter or Muse wake integration. This setup does not
make Muse a target in `cohall devices` or start a new Muse turn when work arrives.

## Relay access

Use an HTTPS relay address reachable from the sandbox. A private relay requires
an approved private network route or tunnel proxy provided by the sandbox host.
Tailscale access on your computer does not give the sandbox the same access.
Keep the relay address stable. If the relay moves with its existing data, switch
the stored address after the new endpoint is reachable:

```bash
unset COHALL_RELAY_URL
npx -y @akshar5/cohall relay use https://new-relay.example.com
```

This verifies and preserves the stored credential. Changing only
`COHALL_RELAY_URL` does not reuse a credential bound to the old address.
See [relay migration](../README.md#move-a-relay) for moving the relay data.

Cohall's requester uses Node's `fetch`. In a proxy-only environment, enable
Node's use of the proxy settings before starting Cohall:

```bash
export NODE_USE_ENV_PROXY=1
```

Preserve the host's `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, and
`NODE_EXTRA_CA_CERTS` settings. If the regular egress proxy cannot reach the
private relay, obtain the correct route from the host operator. Do not guess
proxy endpoints or copy proxy credentials into chat, command arguments, or
checked-in files. A relay listed in `NO_PROXY` bypasses the proxy, which fails
when the sandbox has no direct route to it.

`NODE_USE_ENV_PROXY=1` is supported for `fetch` starting with Node.js 24.0.0,
as documented in [Node's 24.0.0 command-line API](https://nodejs.org/download/release/v24.0.0/docs/api/cli.html#node_use_env_proxy1).
The separate `--use-env-proxy` flag and `http`/`https` agent support need 24.5.0;
this guide uses the environment variable with `fetch`.
See [Node's proxy and certificate guidance](https://nodejs.org/en/learn/http/enterprise-network-configuration).
Keep certificate verification enabled; use the host-provided CA bundle when
its proxy or relay requires one.

## Pair the requester

On an owner-authenticated machine, create a single-use client pairing token
valid for ten minutes:

```bash
npx -y @akshar5/cohall pair --client-only --label "Muse"
```

Transfer that token privately to a mode-`0600` file in the sandbox. Keep the
owner and device credentials on their own machines. Choose a private writable
configuration path, outside shared repositories and artifacts:

```bash
export COHALL_CONFIG=/absolute/private/path/cohall/config.json

npx -y @akshar5/cohall join \
  --relay https://cohall.example.com \
  --client-only \
  --name Muse \
  --token-file /absolute/private/path/cohall-pairing-token

npx -y @akshar5/cohall doctor
npx -y @akshar5/cohall devices
```

`join` stores the client credential at `COHALL_CONFIG`; it does not install a
worker service. No workspace or coding provider is required for this requester.
`doctor` should report a reachable relay and `client_authentication.status` of
`ok`. Its MCP check verifies the local Cohall server, not Muse's tool loading.

Use the same `COHALL_CONFIG` and network environment for later commands. If the
sandbox is replaced, retain the configuration through the host's private
persistent storage or issue a new pairing token. Cohall cannot preserve a file
the host discards.

Client credentials expire 90 days after pairing. Before expiry, collect and
acknowledge completed work and record any outstanding task IDs. Have the relay
owner create a new client-only pairing token, repeat `join` with that new token
file, and run `doctor` again. Each pairing has a separate completion inbox;
results from earlier pairings remain accessible through `status <task-id>` while
the relay retains those tasks. Preserving the configuration does not extend the
credential's expiry.

## Delegate and collect results

For work that may exceed the host's command timeout, enqueue it and keep the
returned task ID:

```bash
npx -y @akshar5/cohall delegate \
  --target @workstation \
  --prompt-file /absolute/path/task.txt \
  --context-file /absolute/path/context.txt \
  --no-wait

npx -y @akshar5/cohall status <task-id>
npx -y @akshar5/cohall inbox
npx -y @akshar5/cohall inbox ack <task-id>
```

Replace `@workstation` with a name or ID from `devices`. Send the question,
relevant facts, prior findings, and constraints in the prompt and context files.
Cohall cannot read the Muse conversation automatically.

Fetch the full result with `status` and acknowledge it after handling it.
`wait <task-id> --timeout <seconds>` polls a specific task; it does not listen
for incoming requests or wake Muse. A wait timeout leaves the task running.
If the host ends long commands or does not deliver background output, check
`status` or `inbox` during subsequent turns. Scheduling and background command
notifications depend on the host.

## Optional MCP

If your Muse host supports local stdio MCP subprocesses, configure it to launch:

```bash
npx -y @akshar5/cohall mcp
```

Pass the same `COHALL_CONFIG`, `NODE_USE_ENV_PROXY=1`, and applicable proxy and CA
settings into that subprocess through the host's secure environment mechanism.
Use only the client credential. Cohall's MCP transport is stdio; the relay URL
is not a remote MCP endpoint.

For queued work, call `delegate` with `wait: false`, then `task_status` or
`completion_inbox`; use `acknowledge_completion` after handling the result.
See [agent integrations](integrations.md) for the common CLI and MCP behavior.
