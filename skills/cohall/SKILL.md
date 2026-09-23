---
name: cohall
description: Delegate through Cohall to another user-owned device or an existing Grok Bot. Use when the user names a Cohall target, asks to message one of their bots, or needs another machine's tools, files, or signed-in services. Carry relevant conversation context into the handoff.
---

# Cohall

Cohall sends a focused task to a coding agent or an existing named Grok Bot. The target
keeps its local files, credentials, browser state, provider login, skills, and
permissions. The relay carries prompts, final results, and task state.

Use the installed `cohall` executable when it is available. Fall back to
`npx -y @akshar5/cohall` only when Cohall is not installed globally.

## Recognize cross-device requests

Treat phrases such as “run this on my Mac,” “ask `@server`,” or “have the Linux
machine check this” as target intent. Resolve computers with `cohall devices`
and named bots with `cohall bots`, then delegate the smallest useful outcome.

Good reasons to delegate include:

- Xcode, simulators, signing state, or a signed-in browser on a Mac;
- Docker services, deployment access, or a repository checkout on a server;
- long tests that can run remotely while useful local work continues;
- any machine-local tool, file, login, or network access unavailable here.

Do not delegate ordinary local work when the other device provides no advantage.

## Delegate work

1. List devices unless the target is already explicit:

   ```bash
   cohall devices
   ```

2. Choose a target whose provider, workspaces, platform, and capabilities fit
   the task. Stay local when another device offers no material advantage.

3. Build the handoff from the current conversation. Do not ask the user to
   repeat information already visible. Write:
   - a concrete `--prompt` describing the target's task;
   - a concise `--context` explaining why the user is asking, relevant facts and
     prior findings, constraints, and the decision or evidence they need.

   When a request depends on the conversation, including references such as
   “this,” “that,” or “look into it,” always supply `--context`. Omit it only
   when the prompt is genuinely self-contained. Distill the context; never
   forward the raw transcript or unrelated private material.

4. Delegate one concrete outcome:

   ```bash
   cohall delegate \
     --target @macbook \
     --provider codex \
     --workspace "$HOME/dev/project" \
     --prompt 'Research whether the deployment failure matches the reported provider outage.' \
     --context 'Why: deployment 184 failed after 15:00 UTC. Known: local checks passed and the provider status page reported elevated errors. Need: determine whether the outage explains our failure, with primary-source links and contrary evidence.'
   ```

   Coding providers are `codex`, `claude-code`, and `opencode`. Omit `--provider`
   to use Codex on a computer; selecting a named bot infers `grok-bot`.
   Omit `--target` only when Cohall may choose a matching computer.

5. The command waits by default and returns JSON. Treat work as successful only
   when `status` is `completed`; use `result` in the current task. Report a
   `failed`, `cancelled`, or `cancelling` state accurately.

6. Reuse `thread_id` for related follow-ups so the target provider can resume
   its local session:

   ```bash
   cohall delegate \
     --thread 11111111-1111-4111-8111-111111111111 \
     --target @macbook \
     --prompt 'Check whether yesterday’s deployment failed for the same reason.'
   ```

When a coding agent running as a Cohall task delegates again, `COHALL_THREAD_ID`
and `COHALL_TASK_ID` carry its thread and parent task. Pass `--thread` and
`--parent` explicitly from a Grok Bot using the IDs in its handoff.

## Message named bots

1. Run `cohall bots` and choose a listed target. Use its qualified target when
   names collide; discovery includes every available bot on configured hosts.
2. Send the prompt and relevant context:

   ```bash
   cohall send @Research --prompt 'Find three project ideas worth exploring.'
   cohall send '@cloud/Video ideas' --prompt 'Suggest an opening for the video.'
   ```

   Named bots use their existing Grok conversation and permissions. Omit
   `--workspace`. A Cohall thread records the exchange; it does not create an
   isolated Grok conversation.

3. Reuse `--thread <thread-id>` for follow-ups. With an explicit thread and no
   target, Cohall resumes its most recent root bot task. Select a computer
   explicitly when delegating a child coding task:

   ```bash
   cohall delegate --target @cloud --provider codex \
     --thread <thread-id> --parent <task-id> --prompt 'Implement the selected idea.'
   ```

Different bots and the computer's coding agent can run concurrently. Each
individual bot processes one Cohall request at a time.

When receiving a Cohall request inside a Grok Bot, finish with the `cohall reply`
command supplied in the handoff. Pass the final answer through `--message-file`
or `--message -` on stdin, then reply normally in chat. Use `--error` if unable
to finish. This local receipt is what returns the result to the sending device;
a chat message alone does not complete the Cohall task. The receipt survives
worker restarts and works while the relay is temporarily unreachable.

## Context and safety

- Preserve the meaning and motivation of the current conversation, not its raw wording.
- Add new relevant developments to `--context` when following up from another chat.
- Never send provider credentials, Cohall tokens, cookies, or browser-profile data.
- Request a path only when the target advertises a matching workspace root.
- Use the same thread for clarification instead of creating duplicate tasks.
- Do not submit the same work through both CLI and MCP.
- Respect user confirmation requirements for consequential actions on the target.

## Asynchronous work

Queue work when the current agent can make independent progress:

```bash
cohall delegate --target @linux --no-wait \
  --prompt 'Run the project test suite and report failures.'
cohall status <task-id>
cohall wait <task-id> --timeout 1800
```

An accepted task for an offline target waits durably on the relay and dispatches
when the device reconnects. Accepted tasks survive relay and device restarts.
The relay itself must be reachable to accept a new task. Interrupted execution
uses at-least-once delivery and may run again, so make consequential prompts safe
to retry.

The timeout error includes the task ID and last known status. The task continues
unless cancelled:

```bash
cohall cancel <task-id>
```

For coding agents, active cancellation is acknowledged by the target device;
`cancelling` means the provider process has not confirmed termination yet.
Queued bot tasks can be cancelled. Stop an active bot in Grok Bot; its gateway
cannot safely cancel an individual Cohall request.

## Read shared context

```bash
cohall thread <thread-id>
```

This returns a byte-bounded recent window of prompts, final responses, and task
states. Check `truncated`; older entries may be outside the returned window or
pruned by the relay's terminal-task retention limit.

## Input forms

Use `--prompt-file` or stdin for multiline work without shell interpolation:

```bash
cohall delegate --target @macbook --prompt - <<'COHALL_PROMPT'
Analyze the authenticated pages in the attached task context.
Return the shared conclusions, disagreements, and source URLs.
COHALL_PROMPT
```

Only one input may read stdin. Use `--context-file` when the prompt uses stdin.

## Diagnostics

Trace a known task before inspecting machine-local service logs:

```bash
cohall trace <task-id> --follow
```

The trace is redacted and reports relay dispatch, device execution, retries,
and terminal state. Use `cohall thread <thread-id>` when prompt and result
history is relevant.

If Cohall cannot connect or no target is available, run:

```bash
cohall doctor
cohall devices
```

Return the diagnostic failure to the user rather than claiming remote work ran.
