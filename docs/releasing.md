# Release operations

Cohall publishes publicly to npm as `@akshar5/cohall`. Releases use Release
Please and npm trusted publishing; no long-lived npm token is stored in GitHub.

Before merging a release:

```bash
bun install --frozen-lockfile
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

The initial `0.2.0` release was published manually and tagged as the automation
baseline. npm trusted publishing is configured for:

- npm package: `@akshar5/cohall`
- repository: `AksharP5/cohall`
- workflow: `release.yml`
- environment: none

Publishing uses GitHub Actions OIDC. Do not add `NPM_TOKEN` or `NODE_AUTH_TOKEN`
to the workflow.
