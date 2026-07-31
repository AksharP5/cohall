# Desktop releases

Cohall Desktop ships from `.github/workflows/desktop-release.yml` as:

- macOS arm64 and x64 DMGs
- Linux x64 AppImage and Debian packages
- Windows x64 NSIS installers

Create the updater signing key once with the Tauri signer, keep its private key
outside the repository, and configure these GitHub Actions secrets:

- `TAURI_UPDATER_PUBLIC_KEY`
- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Direct macOS distribution also requires the `APPLE_*` signing and notarization
secrets referenced by the workflow. Windows code signing can be added through
the Tauri-supported certificate provider before a public release; unsigned
installers will trigger Windows reputation warnings.

Push a version tag such as `v0.1.0`, or run the workflow manually against an
existing immutable tag. Every platform uploads into one draft GitHub release.
Publish the draft only after all required platform jobs pass and the installers
have been smoke-tested on real machines.

The development config intentionally has no updater endpoint or public key.
Release jobs merge those values through `TAURI_CONFIG` and produce signed
`latest.json` updater metadata.
