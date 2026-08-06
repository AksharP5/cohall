---
name: cohall
description: Delegate work to an agent on another user-owned device through the Cohall CLI. Use when a task needs machine-local state or capabilities such as a signed-in browser, Xcode, a simulator, Docker, deployment access, a repository checkout, or tools unavailable on the current device.
---

# Cohall

Cohall sends a focused task to an agent running on another device. The target
keeps its local files, credentials, browser state, provider login, skills, and
permissions. The relay carries prompts, final results, and task state; it is not
a lead agent.

Use the installed `cohall` executable when it is available. Fall back to
`npx -y @akshar5/cohall` only when Cohall is not installed globally.

## Delegate work

1. List devices unless the target is already explicit:

   ```bash
   cohall devices
   ```

2. Choose a target whose provider, workspaces, platform, and capabilities fit
   the task. Stay local when another device offers no material advantage.

3. Delegate one concrete outcome. Send only the context the target needs:

   ```bash
   cohall delegate \
     --target @macbook \
     --provider codex \
     --workspace /Users/me/dev/project \
     --prompt 'Inspect the authenticated dashboard and identify why deployment 184 failed.' \
     --context 'Focus on events after 15:00 UTC. Return evidence and source URLs.'
   ```

   Providers are `codex`, `claude-code`, and `opencode`. Omit `--provider` to
   use Codex. Omit `--target` only when Cohall may choose a matching device.

4. The command waits by default and returns JSON. Treat work as successful only
   when `status` is `completed`; use `result` in the current task. Report a
   `failed`, `cancelled`, or `cancelling` state accurately.

5. Reuse `thread_id` for related follow-ups so the target provider can resume
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

- Include the goal, constraints, relevant prior findings, and expected evidence.
- Do not paste a full private transcript when a short brief is sufficient.
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
