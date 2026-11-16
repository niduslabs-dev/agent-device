#!/bin/sh
# Builds the native client in release mode. Homebrew's LLVM in the shell (CC, CXX, the flags, and
# its bin on PATH) breaks the Swift toolchain, so this build runs without them.
set -eu
cd "$(dirname "$0")"
PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v /opt/homebrew/opt/llvm | paste -sd: -)"
export PATH
exec env -u CC -u CXX -u CPPFLAGS -u LDFLAGS -u LIBRARY_PATH swift build -c release "$@"
