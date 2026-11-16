import path from 'node:path';
import { expect, test } from 'vitest';
import { listCliCommandNames } from '@agent-device/command-registry/catalog';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { runNidusCliArgv } from './nidus-cli-argv.ts';

function request(
  baseDir: string,
  overrides: Partial<{
    argv: string[];
    env: Record<string, string>;
    stderrIsTTY: boolean;
    cwd: unknown;
  }> = {},
) {
  return {
    baseDir,
    request: {
      session: 'default',
      command: 'nidus_cli_argv',
      positionals: [],
      token: 'token',
      input: {
        argv: overrides.argv ?? ['session', 'list'],
        cwd: (overrides.cwd ?? baseDir) as string,
        env: overrides.env ?? hostEnv(baseDir),
        stdoutIsTTY: false,
        stderrIsTTY: overrides.stderrIsTTY ?? false,
      },
    },
  };
}

function hostEnv(baseDir: string): Record<string, string> {
  const env: Record<string, string> = { AGENT_DEVICE_STATE_DIR: baseDir };
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  if (process.env.TMPDIR !== undefined) env.TMPDIR = process.env.TMPDIR;
  return env;
}

function clientOnlyReason(response: Awaited<ReturnType<typeof runNidusCliArgv>>): unknown {
  expect(response.ok).toBe(true);
  return response.ok ? (response.data as { outcome: string; reason?: string }) : undefined;
}

test('a client-only command is handed back before anything runs', async () => {
  const baseDir = mkdtempForTestSync('nidus-cli-argv-');
  const response = await runNidusCliArgv(request(baseDir, { argv: ['connect'] }));
  expect(clientOnlyReason(response)).toEqual({ outcome: 'client-only', reason: 'command:connect' });
});

test('a run for another state dir is handed back to the client', async () => {
  const baseDir = mkdtempForTestSync('nidus-cli-argv-');
  const other = path.join(baseDir, 'other');
  const response = await runNidusCliArgv(
    request(baseDir, { argv: ['session', 'list', '--state-dir', other] }),
  );
  expect(clientOnlyReason(response)).toEqual({ outcome: 'client-only', reason: 'other-state-dir' });
});

test('a terminal stderr and a different home stay with the client', async () => {
  const baseDir = mkdtempForTestSync('nidus-cli-argv-');
  expect(clientOnlyReason(await runNidusCliArgv(request(baseDir, { stderrIsTTY: true })))).toEqual({
    outcome: 'client-only',
    reason: 'stderr-tty',
  });
  const env = { ...hostEnv(baseDir), HOME: path.join(baseDir, 'home') };
  expect(clientOnlyReason(await runNidusCliArgv(request(baseDir, { env })))).toEqual({
    outcome: 'client-only',
    reason: 'home',
  });
});

test('debug output and relative steps files stay with the client', async () => {
  const baseDir = mkdtempForTestSync('nidus-cli-argv-');
  expect(
    clientOnlyReason(await runNidusCliArgv(request(baseDir, { argv: ['snapshot', '--debug'] }))),
  ).toEqual({ outcome: 'client-only', reason: 'debug' });
  expect(
    clientOnlyReason(
      await runNidusCliArgv(request(baseDir, { argv: ['batch', '--steps-file', 'steps.json'] })),
    ),
  ).toEqual({ outcome: 'client-only', reason: 'relative-steps-file' });
});

test('a malformed request is refused as invalid arguments', async () => {
  const baseDir = mkdtempForTestSync('nidus-cli-argv-');
  const response = await runNidusCliArgv(request(baseDir, { cwd: 'relative' }));
  expect(response.ok).toBe(false);
  expect(response.ok ? undefined : response.error.code).toBe('INVALID_ARGS');
});

test('exactly the classified client-only commands are handed back by name', async () => {
  const baseDir = mkdtempForTestSync('nidus-cli-argv-');
  const handedBack: string[] = [];
  for (const command of listCliCommandNames()) {
    const data = clientOnlyReason(await runNidusCliArgv(request(baseDir, { argv: [command] })));
    if ((data as { reason?: string }).reason === `command:${command}`) handedBack.push(command);
  }
  // A new upstream command lands here until it is added to the native set or to this list.
  expect(handedBack.sort()).toEqual([
    'auth',
    'cdp',
    'connect',
    'connection',
    'daemon',
    'device',
    'disconnect',
    'install',
    'install-from-source',
    'mcp',
    'metro',
    'plugins',
    'proxy',
    'react-devtools',
    'record',
    'reinstall',
    'replay',
    'takeover',
    'test',
    'web',
  ]);
});
