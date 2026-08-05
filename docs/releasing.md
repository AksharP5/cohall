# Release operations

Cohall publishes publicly to npm as `@akshar5/cohall`. Releases use Release
Please and npm trusted publishing; no long-lived npm token is stored in GitHub.

Before merging a release:

```bash
bun install --frozen-lockfile
bun run check
bun run check
npm pack --dry-run
```

The Check workflow runs only when manually dispatched or when a non-draft pull
request is opened or marked ready for review. Synchronizing commits does not
automatically consume another private-repository runner allocation.

After releasable conventional commits reach `main`, Release Please opens or
updates one release pull request. Merging it creates the version tag and GitHub
release; the same workflow then publishes that exact version to npm through
GitHub Actions OIDC.

For the first release only, publish locally after the implementation is merged,
create the matching GitHub tag/release, then enable the trusted publisher for:

- npm package: `@akshar5/cohall`
- repository: `AksharP5/cohall`
- workflow: `release.yml`
- environment: none

If npm requires two-factor authentication, provide the OTP only at the prompt.
