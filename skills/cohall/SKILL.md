---
name: cohall
description: Delegate work to agents running on the user's other Cohall devices. Use when a task needs device-local capabilities or state such as a signed-in browser, Xcode, a simulator, Docker, a repository checkout, deployment access, or machine-specific tools. Supports the Cohall CLI without requiring MCP.
---

# Cohall

Use the Cohall CLI to discover the user's devices, delegate a focused task, and
continue with the returned result.

Before the first Cohall command in a session, run:

```bash
cohall skill
```

Read the complete output. It documents device selection, context handoff,
thread continuity, waiting, cancellation, output fields, and safety rules.
The same material is bundled at
[references/cli.md](references/cli.md) when the command is unavailable.

Minimal flow after reading the reference:

```bash
cohall devices
cohall delegate --target @macbook \
  --prompt 'Inspect the authenticated page and report the relevant findings.' \
  --context 'We are investigating the API behavior that changed this week.'
```

The CLI waits by default and emits JSON. Use the returned `result` in the
current task and reuse `thread_id` for follow-up delegations.

If `cohall` is unavailable, run it from a Cohall checkout with:

```bash
bun /absolute/path/to/cohall/apps/device/src/main.ts skill
```

Do not configure or invoke Cohall MCP merely because this skill is active. The
CLI and MCP are equivalent entry points; use whichever integration is already
available in the host.
