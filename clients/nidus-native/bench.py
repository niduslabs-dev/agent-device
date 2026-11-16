#!/usr/bin/env python3
"""Wall time of the Node CLI against the native client on an isolated daemon.

Usage: clients/nidus-native/bench.py [runs]   (default 30; run `pnpm build` and build.sh first)

The daemon gets an empty home and a PATH holding only node, so no device tool is visible and no
command reaches a device. Clients run interleaved, so host load hits both alike. Times include
Python's own spawn cost (a few ms; `/usr/bin/true` is printed as the floor).
"""
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
NODE_BIN = os.path.join(ROOT, "bin", "agent-device.mjs")
NATIVE = os.path.join(ROOT, "clients", "nidus-native", ".build", "release", "agent-device-native")
RUNS = int(sys.argv[1]) if len(sys.argv) > 1 else 30

CASES = [
    ["session", "list"],
    ["session", "list", "--json"],
    ["logs", "path"],
    ["help", "snapshot"],
    ["press"],
    ["devices", "--platform", "android"],
    ["batch", "--steps", '[{"command":"session","positionals":["list"]}]', "--json"],
    ["daemon", "status"],
]


def timed(argv, env, cwd):
    start = time.perf_counter()
    subprocess.run(argv, env=env, cwd=cwd, capture_output=True, timeout=60)
    return (time.perf_counter() - start) * 1000


TRACE = re.compile(r"agent-device-native: native \(client ([0-9.]+) ms, daemon ([0-9.]+) ms\)")


def traced(argv, env, cwd):
    """The native client's own split: its admission work, and the daemon round trip."""
    result = subprocess.run(
        argv, env=dict(env, AGENT_DEVICE_NATIVE_TRACE="1"), cwd=cwd, capture_output=True, timeout=60
    )
    match = TRACE.search(result.stderr.decode())
    return (float(match.group(1)), float(match.group(2))) if match else None


def worker_rss_mb(state_dir):
    """Resident memory of the CLI worker the daemon in `state_dir` owns."""
    with open(os.path.join(state_dir, "daemon.json")) as record:
        daemon_pid = str(json.load(record)["pid"])
    table = subprocess.run(["/bin/ps", "-axo", "ppid=,rss=,command="], capture_output=True).stdout.decode()
    for line in table.splitlines():
        parent, rss, command = line.split(None, 2)
        if parent == daemon_pid and "nidus-cli-worker" in command:
            return int(rss) / 1024
    return float("nan")


def summary(samples):
    return f"{statistics.median(samples):7.1f} ({min(samples):.1f}-{max(samples):.1f})"


def main():
    scratch = os.path.realpath(tempfile.mkdtemp(prefix="nidus-native-bench-"))
    for name in ("home", "cwd", "bin"):
        os.mkdir(os.path.join(scratch, name))
    node = shutil.which("node")
    os.symlink(node, os.path.join(scratch, "bin", "node"))
    env = {
        "HOME": os.path.join(scratch, "home"),
        "PATH": f"{os.path.join(scratch, 'bin')}:/usr/bin:/bin",
        "TMPDIR": os.environ.get("TMPDIR", "/tmp"),
        "AGENT_DEVICE_STATE_DIR": os.path.join(scratch, "state"),
        "AGENT_DEVICE_NO_UPDATE_NOTIFIER": "1",
    }
    cwd = os.path.join(scratch, "cwd")
    bun = shutil.which("bun")
    try:
        subprocess.run([node, NODE_BIN, "session", "list"], env=env, cwd=cwd, capture_output=True, check=True)
        # The first native run starts the daemon's CLI worker; time it apart from the warm runs.
        print(f"first native run (starts the worker): {timed([NATIVE, 'session', 'list'], env, cwd):.1f} ms")
        floor = [timed(["/usr/bin/true"], env, cwd) for _ in range(RUNS)]
        print(f"runs per cell: {RUNS}; /usr/bin/true floor: {summary(floor)} ms")
        header = f"{'command':58} {'node ms':>22} {'native ms':>22}"
        if bun:
            header += f" {'native+bun ms':>22}"
        header += f" {'client/daemon ms':>18}"
        print(header)
        for case in CASES:
            splits = [s for s in (traced([NATIVE, *case], env, cwd) for _ in range(RUNS)) if s]
            node_samples, native_samples, bun_samples = [], [], []
            bun_env = dict(env, AGENT_DEVICE_NATIVE_FALLBACK="bun", PATH=f"{env['PATH']}:{os.path.dirname(bun)}") if bun else None
            for _ in range(RUNS):
                node_samples.append(timed([node, NODE_BIN, *case], env, cwd))
                native_samples.append(timed([NATIVE, *case], env, cwd))
                if bun_env:
                    bun_samples.append(timed([NATIVE, *case], bun_env, cwd))
            label = " ".join(case)
            label = label if len(label) <= 56 else label[:53] + "..."
            row = f"{label:58} {summary(node_samples):>22} {summary(native_samples):>22}"
            if bun_env:
                row += f" {summary(bun_samples):>22}"
            if splits:
                client = statistics.median(split[0] for split in splits)
                daemon = statistics.median(split[1] for split in splits)
                row += f" {client:>8.1f}/{daemon:<8.1f}"
            else:
                row += f" {'fallback':>18}"
            print(row)
        print(f"CLI worker RSS after the runs: {worker_rss_mb(os.path.join(scratch, 'state')):.0f} MB")
    finally:
        subprocess.run([node, NODE_BIN, "daemon", "stop"], env=env, cwd=cwd, capture_output=True)
        shutil.rmtree(scratch, ignore_errors=True)


if __name__ == "__main__":
    main()
