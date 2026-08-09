# Contributing to Cohall

Issues and focused pull requests are welcome.

## Before opening an issue

- Search existing issues and confirm the problem still occurs on the latest
  Cohall release.
- Include the operating system, Node.js version, Cohall version, relevant
  command, expected behavior, and redacted output.
- Remove relay URLs, device names, workspace paths, tokens, provider session
  IDs, and other private information.
- Report security vulnerabilities through [GitHub's private vulnerability
  form](https://github.com/AksharP5/cohall/security/advisories/new), not a public
  issue.

## Development

Requirements:

- Node.js 24 or newer
- [Bun](https://bun.sh/) 1.3.13

Install dependencies and run the full local validation suite:

```bash
bun install --frozen-lockfile
bun run check
```

`bun run check` type-checks, lints, builds the npm executable, runs the relay,
device, CLI, provider, and MCP tests, and validates the package contents.

Format changed files with `bunx oxfmt <files>` and verify the patch with `git
diff --check`. Do not hand-edit generated files in `bin/`.

## Pull requests

- Keep each pull request focused on one problem.
- Add high-signal tests for behavior changes and meaningful edge cases.
- Update relevant documentation when behavior or commands change.
- Do not include credentials, personal paths, service logs, or unrelated files.
- Use a Conventional Commit title such as `fix(device): reconnect after sleep`
  or `feat(cli): add task filtering`.
- Explain the user problem first, then the solution and local validation.

Maintainers handle version bumps, changelog entries, tags, and npm publishing
through the Release Please pull request. Contributors should not edit them for a
normal change.
