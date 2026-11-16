#!/usr/bin/env bash
# Installs or updates the niduslabs-dev/agent-device fork from its GitHub Releases.
#
# The package goes into its own npm prefix (never a global install). ~/.local/bin/agent-device
# links to the native client inside it, which runs the Node CLI of the same install for whatever it
# does not handle itself; ~/.local/bin/agent-device-node links to that Node CLI directly. A release
# without a native client, or a host that cannot run it, gets the Node CLI under both names.
# Put ~/.local/bin before Homebrew on PATH to use the fork; remove the links to fall back to
# Homebrew's upstream agent-device. Re-running updates to the newest release.
#
# Usage: install-latest.sh [--version vX.Y.Z-nidus.N]
#
# Environment overrides (for testing): AGENT_DEVICE_FORK_REPO, AGENT_DEVICE_FORK_PREFIX,
# AGENT_DEVICE_FORK_BIN_DIR.
set -euo pipefail

readonly REPO="${AGENT_DEVICE_FORK_REPO:-niduslabs-dev/agent-device}"
readonly PREFIX="${AGENT_DEVICE_FORK_PREFIX:-$HOME/.local/share/agent-device-fork}"
readonly BIN_DIR="${AGENT_DEVICE_FORK_BIN_DIR:-$HOME/.local/bin}"
readonly API="https://api.github.com/repos/$REPO/releases"

die() {
  echo "install-latest: $*" >&2
  exit 1
}

usage() {
  echo "Usage: $0 [--version vX.Y.Z-nidus.N]"
}

tag=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || die "--version needs a tag"
      tag="$2"
      shift 2
      ;;
    --version=*)
      tag="${1#--version=}"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

for tool in curl node npm shasum; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
done

if [ -n "$tag" ]; then
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-nidus\.[0-9]+$ ]] || die "tag must look like vX.Y.Z-nidus.N, got '$tag'"
  release_url="$API/tags/$tag"
else
  release_url="$API/latest"
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl -fsSL -H 'Accept: application/vnd.github+json' -o "$work/release.json" "$release_url" ||
  die "could not read release ${tag:-latest} of $REPO"

# Prints: tag, then the .tgz URL and name, then the .sha256 URL. node is already required by the CLI.
# shellcheck disable=SC2016 # The single-quoted text is JavaScript, not shell.
release_fields="$(node -e '
  const release = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const assets = release.assets ?? [];
  const tgz = assets.find((a) => /^agent-device-.*\.tgz$/.test(a.name));
  const sum = tgz && assets.find((a) => a.name === `${tgz.name}.sha256`);
  if (!tgz || !sum) { console.error(`release ${release.tag_name} lacks the .tgz or its .sha256`); process.exit(1); }
  console.log([release.tag_name, tgz.browser_download_url, tgz.name, sum.browser_download_url].join("\n"));
' "$work/release.json")" || die "unexpected release metadata"

{
  read -r release_tag
  read -r tgz_url
  read -r tgz_name
  read -r sum_url
} <<<"$release_fields"

[[ "$tgz_name" =~ ^agent-device-[0-9A-Za-z.-]+\.tgz$ ]] || die "unexpected asset name '$tgz_name'"

echo "Downloading $tgz_name from $REPO $release_tag"
curl -fsSL -o "$work/$tgz_name" "$tgz_url" || die "download failed: $tgz_url"
curl -fsSL -o "$work/$tgz_name.sha256" "$sum_url" || die "download failed: $sum_url"

expected="$(awk 'NR == 1 { print $1 }' "$work/$tgz_name.sha256")"
actual="$(shasum -a 256 "$work/$tgz_name" | awk '{ print $1 }')"
[[ "$expected" =~ ^[0-9a-f]{64}$ ]] || die "malformed checksum file"
[ "$expected" = "$actual" ] || die "SHA-256 mismatch for $tgz_name (expected $expected, got $actual)"
echo "SHA-256 verified: $actual"

mkdir -p "$PREFIX" "$BIN_DIR"
npm install --prefix "$PREFIX" --no-audit --no-fund --omit=dev "$work/$tgz_name"

readonly PACKAGE="$PREFIX/node_modules/agent-device"
readonly NODE_CLI="$PACKAGE/bin/agent-device.mjs"
readonly NATIVE_CLIENT="$PACKAGE/clients/nidus-native/dist/agent-device-native"

[ -x "$NODE_CLI" ] || die "installed package has no executable at $NODE_CLI"
installed_version="$("$NODE_CLI" --version)" || die "the installed Node CLI does not run"
ln -sfn "$NODE_CLI" "$BIN_DIR/agent-device-node"

# The native client finds its package by walking up from its own real path, so it must stay inside
# the package and be reached through a link. pnpm pack drops the executable bit of non-bin files.
client="$NODE_CLI"
if [ -f "$NATIVE_CLIENT" ]; then
  chmod 755 "$NATIVE_CLIENT"
  if [ "$("$NATIVE_CLIENT" --version 2>/dev/null || true)" = "$installed_version" ]; then
    client="$NATIVE_CLIENT"
  else
    echo "Note: the native client does not run on this host. Linking the Node CLI instead." >&2
  fi
else
  echo "Note: $release_tag ships no native client. Linking the Node CLI instead." >&2
fi
ln -sfn "$client" "$BIN_DIR/agent-device"

case "$client" in
  "$NATIVE_CLIENT") kind="native client" ;;
  *) kind="Node CLI" ;;
esac
echo "Installed agent-device $installed_version ($kind) at $BIN_DIR/agent-device"
echo "Node CLI: $BIN_DIR/agent-device-node"
resolved="$(command -v agent-device || true)"
if [ "$resolved" != "$BIN_DIR/agent-device" ]; then
  echo "Note: agent-device on PATH resolves to '${resolved:-nothing}'. Put $BIN_DIR first on PATH." >&2
fi
