# Nidus Labs fork

`niduslabs-dev/agent-device` is a fork of [callstack/agent-device](https://github.com/callstack/agent-device).
It is rebased onto upstream's `main` and carries fixes we use before they land upstream. It
publishes nothing to npm; builds ship as GitHub Releases.

## What the fork changes

See `git log upstream/main..main` for the exact list. In short:

- Snapshot text output prints frames (with their unit in the header), collapses keyboards and
  labels unlabeled buttons.
- `press`, `click`, `longpress` and `fill` accept a bare name as the target.
- Settings commands read appearance back and wait for the UI to settle afterwards.
- Android: stopped AVDs are reported as shut down, running emulators by their AVD name, and a fill
  no longer taps a field that already has focus.
- Faster fills, key events, capture settling and daemon-client startup.

Fork-only files use a `nidus` name so upstream rebases do not conflict:
`.github/workflows/nidus-release.yml`, `scripts/nidus/` and this page.

## Releasing

Push a tag `vX.Y.Z-nidus.N`, where `X.Y.Z` is the upstream version the fork builds towards and `N`
counts fork releases of it:

```bash
git tag v0.21.39-nidus.1
git push origin v0.21.39-nidus.1
```

The **Nidus release** workflow builds the package on a GitHub-hosted macOS runner, stamps the
version from the tag (nothing is committed), runs `pnpm pack`, and creates a GitHub Release with
the `.tgz` and its `.sha256`. To rebuild a failed release, run the workflow by hand with the tag.
Never move a pushed tag; cut the next `-nidus.N` instead.

GitHub Actions is enabled for the fork, but every upstream workflow is disabled
(`gh workflow list --all`). Only **Nidus release** runs. After a rebase brings in a new upstream
workflow, disable it with `gh workflow disable <file>`.

## Installing

```bash
scripts/nidus/install-latest.sh                        # latest release, or update to it
scripts/nidus/install-latest.sh --version v0.21.39-nidus.1
```

The script verifies the SHA-256, installs into `~/.local/share/agent-device-fork` with
`npm install --prefix` (never globally) and links `~/.local/bin/agent-device`. `~/.local/bin`
must come before Homebrew on `PATH`.

To uninstall, remove the link; `agent-device` falls back to Homebrew's upstream build:

```bash
rm ~/.local/bin/agent-device
rm -rf ~/.local/share/agent-device-fork   # optional
```
