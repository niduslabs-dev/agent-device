import { afterEach, expect, test, vi } from 'vitest';
import { capturedCliExit, refuseCapturedCli, runCapturedCli } from './nidus-cli-capture.ts';

const NOT_TTY = { stdoutIsTTY: false, stderrIsTTY: false };

afterEach(() => {
  vi.restoreAllMocks();
});

test('a captured run collects its stdout and stderr writes in order and ends at its exit', async () => {
  let ranPastExit = false;
  const outcome = await runCapturedCli(NOT_TTY, async () => {
    process.stderr.write('progress\n');
    process.stdout.write('result\n');
    process.stderr.write(Buffer.from('bytes\n'));
    await capturedCliExit(3);
    ranPastExit = true;
    process.stdout.write('after exit\n');
  });
  expect(outcome).toEqual({
    kind: 'exit',
    exitCode: 3,
    output: [
      [2, 'progress\n'],
      [1, 'result\n'],
      [2, 'bytes\n'],
    ],
  });
  expect(ranPastExit).toBe(false);
});

test('a captured run that returns exits 0', async () => {
  const outcome = await runCapturedCli(NOT_TTY, async () => {
    process.stdout.write('done\n');
  });
  expect(outcome).toEqual({ kind: 'exit', exitCode: 0, output: [[1, 'done\n']] });
});

test('a refused run reports the reason and drops what it printed', async () => {
  const outcome = await runCapturedCli(NOT_TTY, async () => {
    process.stderr.write('Warning: parsed\n');
    await refuseCapturedCli('remote-daemon');
  });
  expect(outcome).toEqual({ kind: 'client-only', reason: 'remote-daemon' });
});

test('isTTY reads the client streams inside a run and the process streams outside', async () => {
  const outside = { stdout: process.stdout.isTTY, stderr: process.stderr.isTTY };
  let inside: { stdout: unknown; stderr: unknown } | undefined;
  await runCapturedCli({ stdoutIsTTY: true, stderrIsTTY: false }, async () => {
    inside = { stdout: process.stdout.isTTY, stderr: process.stderr.isTTY };
  });
  expect(inside).toEqual({ stdout: true, stderr: false });
  expect({ stdout: process.stdout.isTTY, stderr: process.stderr.isTTY }).toEqual(outside);
});

test('concurrent runs keep their own output', async () => {
  const run = (label: string, exitCode: number) =>
    runCapturedCli(NOT_TTY, async () => {
      process.stdout.write(`${label} 1\n`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      process.stdout.write(`${label} 2\n`);
      await capturedCliExit(exitCode);
    });
  const [first, second] = await Promise.all([run('a', 1), run('b', 2)]);
  expect(first).toEqual({
    kind: 'exit',
    exitCode: 1,
    output: [
      [1, 'a 1\n'],
      [1, 'a 2\n'],
    ],
  });
  expect(second).toEqual({
    kind: 'exit',
    exitCode: 2,
    output: [
      [1, 'b 1\n'],
      [1, 'b 2\n'],
    ],
  });
});

test('outside a run, an exit is not captured', () => {
  expect(capturedCliExit(1)).toBeUndefined();
});
