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
- Android emulator input (taps, swipes, scrolls, back, home) goes through the emulator's own gRPC
  endpoint instead of the snapshot helper (ADR 0041).

- A native thin client (below) that runs a command in about 10 ms instead of about 150 ms.

Fork-only files use a `nidus` name so upstream rebases do not conflict:
`.github/workflows/nidus-release.yml`, `scripts/nidus/`, `clients/nidus-native/`, the
`nidus-*` modules under `src/` and `packages/`, and this page.

## Native thin client

`clients/nidus-native/` is a Swift client (macOS 15+, no dependencies). It does not parse or
render anything itself. It sends the raw argv, its cwd and its environment to the running daemon
as a `nidus_cli_argv` request. The daemon runs the Node CLI's own entry, parser, client and
formatters on it (`src/nidus-cli-argv.ts`) and answers with every stdout and stderr write in
order plus the exit code. The output is the Node CLI's by construction.

```bash
clients/nidus-native/build.sh                         # swift build -c release, without Homebrew LLVM
clients/nidus-native/.build/release/agent-device-native session list
```

The client finds the agent-device tree by walking up from its own path, or from
`AGENT_DEVICE_NATIVE_ROOT`. It runs the Node CLI on the same argv instead when:

- no daemon is registered, or the registered one is not the one the Node CLI would reuse
  (another version, other code, a policy, a dead or foreign lock owner, no socket port);
- stderr is a terminal, a remote daemon or a daemon policy is set in the environment;
- the daemon hands the run back as client-only. Each CLI command is classified in
  `src/nidus-cli-argv.ts`, and a unit test fails until a new upstream command is classified.
  Client-only runs include remote connections and auth, `daemon`, `install`, `replay`, `test`,
  `record`, `web`, `cdp`, `mcp`, `--debug`, `--text-stdin`, and a config that names another state
  dir.

It never starts, replaces or stops a daemon; the Node CLI does that. If the connection drops after
the request was sent, it reports an error instead of rerunning a command that may have run.

- `AGENT_DEVICE_NATIVE_TRACE=1` prints the route and the client and daemon time to stderr.
- `AGENT_DEVICE_NATIVE_FALLBACK=bun` runs a client-only command under Bun (about 60 ms instead of
  about 150 ms), but only when a reusable daemon exists, so Bun never starts a daemon.
- `AGENT_DEVICE_NATIVE_NODE` names the node binary to fall back to.

`test/integration/smoke-nidus-native-parity.test.ts` runs device-free commands through both
clients and requires byte-identical output. `clients/nidus-native/bench.py` measures both.

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
