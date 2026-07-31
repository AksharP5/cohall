# Cohall CLI Agent Reference

Cohall lets agents running on the user's own devices work together in a shared
conversation. Each device keeps its local files, tools, provider login, browser
state, and permissions. The relay stores messages and task state, but it does
not plan work or act as a lead agent.

## Configuration

The CLI reads the same environment as the Cohall device daemon and MCP server:

```bash
export COHALL_RELAY_URL=http://relay:8787
export COHALL_TOKEN=replace-with-a-device-or-automation-session-token
export COHALL_DEVICE_NAME=linux
export COHALL_DEVICE_WORKSPACES=/home/user/dev,/home/user/.skillsync/repo
```

Use `cohall doctor` to verify relay reachability, local identity, allowed
workspaces, and Codex availability.

All operational commands emit JSON to stdout. Errors are JSON on stderr and
exit with a nonzero status.

## Standard workflow

1. Discover devices when the right target is not already clear:

   ```bash
   cohall devices
   ```

2. Choose a device from its platform, status, capabilities, and advertised
   workspaces. Omit `--target` when Cohall may select an appropriate online
   device.

3. Delegate one clear outcome:

   ```bash
   cohall delegate \
     --target @macbook \
     --workspace /Users/me/dev/project \
     --prompt 'Open the authenticated dashboard, investigate the failed run, and return the cause with supporting links.' \
     --context 'The local Linux agent is debugging deployment 184. Focus on events after 15:00 UTC.'
   ```

4. The command waits for a terminal result by default. Incorporate `result`
   into the current task. Do not tell the user the remote work succeeded when
   the returned `status` is `failed` or `cancelled`.

5. Reuse the returned `thread_id` for related follow-ups:

   ```bash
   cohall delegate \
     --thread 11111111-1111-4111-8111-111111111111 \
     --target @macbook \
     --prompt 'Check whether the same failure appears in yesterday’s run.'
   ```

When a Cohall device agent delegates again, Cohall automatically inherits the
current `COHALL_THREAD_ID`. Pass `--thread` explicitly when continuing from an
ordinary shell or a separate host-agent turn.

## Context rules

The CLI, like MCP, does not receive the current agent's private transcript.
Write the delegated prompt from the context you already have.

- Send only the goal, constraints, resources, and prior findings the target
  needs.
- Do not paste the entire conversation when a short brief is sufficient.
- Never include provider credentials, Cohall tokens, cookies, or browser
  profile data.
- Refer to local paths only when the target device advertises that workspace.
- Ask the target agent to return evidence such as links, commands, test output,
  screenshots, commits, or file paths when the parent task needs them.
- Use a follow-up in the same Cohall thread when the result is incomplete or
  ambiguous.

Browser cookies, Codex authentication, and filesystem permissions stay on the
target device. Cohall transfers the task and its result, not the underlying
secret state.

## Commands

### List devices

```bash
cohall devices
```

Returns device IDs, names, hostnames, platforms, online state, providers,
capabilities, and allowed workspaces.

### Delegate and wait

```bash
cohall delegate [prompt] [options]
```

Options:

- `--prompt`, `-p`: task text.
- `--prompt-file`: read task text from a file.
- `--context`, `-c`: relevant parent context.
- `--context-file`: read context from a file.
- `--target`, `-t`: device name, `@name`, hostname, or device ID.
- `--thread`, `-T`: existing Cohall thread UUID.
- `--workspace`, `-w`: target-device workspace.
- `--timeout`: wait for 5–3600 seconds; default is 900.
- `--no-wait`: return immediately after queueing.

For multiline task text without shell interpolation, read the prompt from
stdin:

```bash
cohall delegate --target @macbook --prompt - <<'COHALL_PROMPT'
Analyze these authenticated pages:
- https://example.com/one
- https://example.com/two

Return the shared conclusions, disagreements, and source URLs.
COHALL_PROMPT
```

Only one input may consume stdin in a command. Use `--context-file` when the
prompt already uses `--prompt -`.

The result shape is:

```json
{
  "task_id": "uuid",
  "thread_id": "uuid",
  "status": "completed",
  "target_device_id": "uuid",
  "result": "Remote agent response",
  "error": null
}
```

Undefined fields may be omitted.

### Queue without waiting

```bash
cohall delegate --target @linux --no-wait \
  --prompt 'Run the full test suite and report any failures.'
```

The initial status can be `queued`, `assigned`, or `running`. Save the returned
`task_id`, then use:

```bash
cohall status <task-id>
cohall wait <task-id>
cohall wait <task-id> --timeout 1800
```

`wait` returns immediately when the task is already terminal.

### Cancel work

```bash
cohall cancel <task-id>
```

Cancellation is best effort for active provider processes. Inspect the returned
status rather than assuming the task was interrupted.

### Read the shared thread

```bash
cohall thread <thread-id>
```

Returns the Cohall thread, its visible device-agent messages, and delegated
tasks. Use this when resuming cross-device work or understanding a nested
delegation.

### Help and diagnostics

```bash
cohall --help
cohall doctor
cohall skill
```

### Access management

These commands require the relay owner token and are for human setup or
administration, not routine agent delegation:

```bash
cohall pair --label "Work laptop"
cohall pair --client-only --label "Browser"
cohall sessions
cohall revoke <session-id>
```

`pair` returns a one-time credential that expires after ten minutes. Desktop
exchanges the default client-and-device credential and binds the resulting
session to its device ID. The browser accepts a `--client-only` credential in
its connection dialog. `sessions` lists metadata only; plaintext session tokens
are never listed again.

## CLI and MCP

Cohall supports both entry points:

- CLI plus this skill keeps tool schemas out of the host context and works in
  agents that can execute shell commands and load skills.
- MCP provides discoverable typed tools for hosts that prefer native tool
  integration.

Both call the same relay client and create the same tasks, shared threads, and
device-side Codex sessions. Do not submit the same task through both.

## Delegation judgment

Delegate when another device has materially better local capability or state:

- macOS for Xcode, simulators, signed-in browser research, or computer use.
- Linux for repositories, Docker, local builds, or Linux-only reproduction.
- VPS for deployment state, production logs, or long-running server work.

Stay local when the current device can complete the work efficiently.
Delegation has network and agent latency, so do not split trivial steps merely
to involve another device.

Agents are peers. Any device agent may ask another device for help, and the
reply returns to the requesting task through the shared Cohall thread.
