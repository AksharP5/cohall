---
name: cohall
description: Delegate work to an agent on another user-owned device through the Cohall CLI. Use when the user asks to run, research, or check something on another device, names a Cohall target such as @macbook or @server, or needs machine-local state or capabilities such as a signed-in browser, Xcode, Docker, deployment access, a repository checkout, or unavailable tools. Carry the relevant current-conversation context into the handoff automatically.
---

# Cohall

Cohall sends a focused task to an agent running on another device. The target
keeps its local files, credentials, browser state, provider login, skills, and
permissions. The relay carries prompts, final results, and task state; it is not
a lead agent.

Use the installed `cohall` executable when it is available. Fall back to
`npx -y @akshar5/cohall` only when Cohall is not installed globally.

## Recognize cross-device requests

Treat phrases such as “run this on my Mac,” “ask `@server`,” or “have the Linux
machine check this” as target intent. The `@name` form is a Cohall device
selector, not chat syntax supplied by the harness. Resolve it with `cohall
devices`, then delegate the smallest useful outcome.

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

   Providers are `codex`, `claude-code`, and `opencode`. Omit `--provider` to
   use Codex. Omit `--target` only when Cohall may choose a matching device.

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

When an agent running as a Cohall task delegates again, `COHALL_THREAD_ID`
automatically carries the current thread. Pass `--thread` explicitly from an
ordinary shell or a separate agent turn.

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

Active cancellation is acknowledged by the target device; `cancelling` means
the provider process has not confirmed termination yet.

## Read shared context

```bash
cohall thread <thread-id>
```

This returns a byte-bounded recent window of prompts, final responses, and task
states. Check `truncated`; older history remains on the relay when it is true.

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
