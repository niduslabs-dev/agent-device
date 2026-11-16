#!/bin/sh
# Builds the native client as a universal (arm64 + x86_64) release binary into dist/, where the
# package's `files` list picks it up, and ad-hoc signs it: Apple silicon refuses to run unsigned
# code, and a signature made here survives the tarball. Run by the Nidus release workflow before
# `pnpm pack`; scripts/nidus/install-latest.sh links the result as `agent-device`.
set -eu
cd "$(dirname "$0")"
./build.sh --arch arm64 --arch x86_64
bin_dir="$(./build.sh --arch arm64 --arch x86_64 --show-bin-path)"
rm -rf dist
mkdir -p dist
cp "$bin_dir/agent-device-native" dist/agent-device-native
chmod 755 dist/agent-device-native
codesign --force --sign - --identifier dev.niduslabs.agent-device-native dist/agent-device-native
codesign --verify --strict dist/agent-device-native
archs="$(lipo -archs dist/agent-device-native)"
case "$archs" in
  *arm64*x86_64* | *x86_64*arm64*) ;;
  *) echo "package.sh: expected a universal binary, got '$archs'" >&2; exit 1 ;;
esac
echo "dist/agent-device-native ($archs)"
