// Fork-only (Nidus Labs): the native thin client must print exactly what the Node CLI prints.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCmdSync } from '@agent-device/host-kit/command';
import { skipWhenLoopbackUnavailable } from '@agent-device/test-kit';
import { cleanupDaemonTestState } from './support/daemon-test-cleanup.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const NODE_BIN = path.join(ROOT, 'bin', 'agent-device.mjs');
const NATIVE_DIR = path.join(ROOT, 'clients', 'nidus-native');
const NATIVE_BIN = path.join(NATIVE_DIR, '.build', 'release', 'agent-device-native');
const RUN_TIMEOUT_MS = 60_000;
const BUILD_TIMEOUT_MS = 600_000;

type Run = { exitCode: number; stdout: string; stderr: string };

/**
 * Commands that never dispatch to a device: this host's tools are hidden (an empty home and a
 * PATH without adb), so a device-facing command fails the same way every time.
 */
const NATIVE_CASES: readonly (readonly string[])[] = [
  ['--version'],
  ['-V'],
  [],
  ['help'],
  ['help', 'snapshot'],
  ['snapshot', '--help'],
  ['help', 'no-such-topic'],
  ['no-such-command'],
  ['snapshot', '--no-such-flag'],
  ['press'],
  ['press', '--json'],
  ['session', 'list'],
  ['session', 'list', '--json'],
  ['logs', 'path'],
  ['logs', 'path', '--json'],
  ['close'],
  ['close', '--json'],
  ['wait', '10'],
  ['devices', '--platform', 'android'],
  ['devices', '--platform', 'android', '--json'],
  ['snapshot', '-i', '--platform', 'android'],
  ['batch', '--steps', '[{"command":"session","positionals":["list"]}]', '--json'],
];

/** Commands the daemon hands back to the Node CLI. */
const FALLBACK_CASES: readonly (readonly string[])[] = [['connection'], ['daemon', 'status']];

/** Per-run values: two Node runs differ in these too. */
function masked(text: string): string {
  return text
    .replaceAll(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/g, '<timestamp>')
    .replaceAll(/\b[a-z0-9]{8}-[0-9a-f]{8}\b/g, '<diagnostic-id>')
    .replaceAll(/\b[0-9a-f]{16}\b/g, '<request-id>');
}

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Run {
  const result = runCmdSync(command, [...args], {
    allowFailure: true,
    env,
    cwd,
    timeoutMs: RUN_TIMEOUT_MS,
  });
  return { exitCode: result.exitCode, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Both streams through one pipe, which shows the order of stdout and stderr writes. */
function runMerged(command: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string) {
  return run('/bin/sh', ['-c', '"$0" "$@" 2>&1', command, ...args], env, cwd);
}

function assertSame(label: string, node: Run, native: Run): void {
  assert.equal(native.exitCode, node.exitCode, `${label}: exit code`);
  assert.equal(masked(native.stdout), masked(node.stdout), `${label}: stdout`);
  assert.equal(masked(native.stderr), masked(node.stderr), `${label}: stderr`);
}

test('the native client prints what the Node CLI prints', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('the native client is macOS only');
    return;
  }
  if (await skipWhenLoopbackUnavailable(t)) return;
  assert.ok(
    fs.existsSync(path.join(ROOT, 'dist', 'src', 'internal', 'bin.js')) ||
      fs.existsSync(path.join(ROOT, 'dist', 'src', 'bin.js')),
    'run pnpm build first: the native client falls back to the built CLI',
  );
  const build = runCmdSync(path.join(NATIVE_DIR, 'build.sh'), [], {
    allowFailure: true,
    timeoutMs: BUILD_TIMEOUT_MS,
  });
  assert.equal(build.exitCode, 0, build.stderr);

  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nidus-native-parity-')));
  const stateDir = path.join(scratch, 'state');
  const home = path.join(scratch, 'home');
  const cwd = path.join(scratch, 'project');
  const bin = path.join(scratch, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  fs.mkdirSync(bin);
  // Node alone, so no device tool on this host's PATH is visible to either client or the daemon.
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
    TMPDIR: process.env.TMPDIR,
    AGENT_DEVICE_STATE_DIR: stateDir,
    AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1',
  };
  try {
    const started = run(process.execPath, [NODE_BIN, 'session', 'list'], env, cwd);
    assert.equal(started.exitCode, 0, started.stderr);

    for (const args of NATIVE_CASES) {
      const label = `agent-device ${args.join(' ')}`;
      const traced = run(NATIVE_BIN, args, { ...env, AGENT_DEVICE_NATIVE_TRACE: '1' }, cwd);
      assert.match(traced.stderr, /^agent-device-native: native \(/m, `${label}: route`);
      assertSame(
        label,
        run(process.execPath, [NODE_BIN, ...args], env, cwd),
        run(NATIVE_BIN, args, env, cwd),
      );
      assertSame(
        `${label} (merged)`,
        runMerged(process.execPath, [NODE_BIN, ...args], env, cwd),
        runMerged(NATIVE_BIN, args, env, cwd),
      );
    }

    for (const args of FALLBACK_CASES) {
      const label = `agent-device ${args.join(' ')}`;
      const traced = run(NATIVE_BIN, args, { ...env, AGENT_DEVICE_NATIVE_TRACE: '1' }, cwd);
      assert.match(traced.stderr, /^agent-device-native: node \(client-only: /m, `${label}: route`);
      assertSame(
        label,
        run(process.execPath, [NODE_BIN, ...args], env, cwd),
        run(NATIVE_BIN, args, env, cwd),
      );
    }
  } finally {
    await cleanupDaemonTestState(stateDir, null);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
