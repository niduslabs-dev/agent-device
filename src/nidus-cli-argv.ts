// Fork-only (Nidus Labs): runs a native client's raw CLI argv through the Node CLI's own entry,
// parser, client and formatters, so what it prints is byte-identical by construction. It runs in
// the daemon's CLI worker process (`nidus-cli-worker.ts`), never in the daemon itself. See
// `docs/nidus-fork.md`.
import fs from 'node:fs';
import path from 'node:path';
import {
  createDaemonTransport,
  createNidusAttachedTransport,
  readRegisteredDaemon,
  type DaemonInfo,
} from '@agent-device/daemon-client';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { isKnownCliCommandName } from '@agent-device/command-registry/catalog';
import { runEntry } from './cli/entry.ts';
import {
  capturedCliExit,
  refuseCapturedCli,
  runCapturedCli,
  writeCapturedCli,
  type CapturedCliOutcome,
} from './cli/nidus-cli-capture.ts';
import { resolveCliOptions } from './cli/resolve-cli-options.ts';

declare const __AGENT_DEVICE_VERSION__: string;

/**
 * Commands whose whole CLI run is daemon requests plus formatting, so it behaves the same in the
 * daemon's worker as in the client's process. Every other command, including one upstream adds later,
 * runs in the client's own Node CLI. Those need the client's process:
 *
 * - `auth`, `connect`, `connection`, `disconnect`, `proxy`: remote state, sign-in and tunnels.
 * - `daemon`: the daemon lifecycle. `device`: local device ownership without a daemon.
 * - `install`, `reinstall`, `install-from-source`: artifact upload and the install notice.
 * - `replay`, `test`: scripts and reporters read and write client files.
 * - `record`: local video tools. `metro`, `web`, `cdp`, `react-devtools`, `mcp`: local processes.
 * - `plugins`: reads the process environment. `takeover`: waits on client signals.
 */
const NATIVE_CLI_COMMANDS: ReadonlySet<string> = new Set([
  'action-button',
  'alert',
  'app-switcher',
  'apps',
  'appstate',
  'artifacts',
  'audio',
  'back',
  'batch',
  'boot',
  'capabilities',
  'click',
  'clipboard',
  'close',
  'debug',
  'devices',
  'diff',
  'doctor',
  'events',
  'fill',
  'find',
  'focus',
  'fold',
  'gesture',
  'get',
  'hardware-button',
  'home',
  'hover',
  'is',
  'keyboard',
  'logs',
  'longpress',
  'network',
  'open',
  'orientation',
  'perf',
  'prepare',
  'press',
  'push',
  'react-native',
  'screenshot',
  'scroll',
  'session',
  'settings',
  'shutdown',
  'snapshot',
  'swipe',
  'telephony',
  'trace',
  'trigger-app-event',
  'tv-remote',
  'type',
  'uninstall',
  'viewport',
  'wait',
]);

type NidusCliArgvInput = Readonly<{
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdoutIsTTY: boolean;
  stderrIsTTY: boolean;
}>;

/** One run as the worker receives it: the client's request input and what the daemon adds. */
export type NidusCliArgvRun = Readonly<{
  /** The `input` of the client's `nidus_cli_argv` request, unvalidated. */
  input: unknown;
  /** The resolved state dir of the daemon that owns this worker. */
  baseDir: string;
  /** That daemon's process id; the run reaches no other daemon. */
  daemonPid: number;
  /** The worker's own host, which is the daemon's: the client's home and temp dir must match it. */
  workerHost: HostEnvironment;
  /** Aborts the run's daemon requests, as the client disconnecting would. */
  signal: AbortSignal;
  /** Called just before a request of the run leaves for the daemon. */
  onDispatch: () => void;
}>;

let ownerRegistration: Promise<DaemonInfo | null> | undefined;

/**
 * Answers one `nidus_cli_argv` request: `{ outcome: 'exit', exitCode, output }`, where `output` is
 * every stdout (`1`) and stderr (`2`) write in order, or `{ outcome: 'client-only', reason }` when
 * the run needs the client's own process. A client-only answer is given only before the run sent
 * anything to a daemon, so the client may run the Node CLI on the same argv.
 */
export async function runNidusCliArgv(run: NidusCliArgvRun): Promise<DaemonResponse> {
  let input: NidusCliArgvInput;
  try {
    input = readInput(run.input);
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
  const refusal = admissionRefusal(input, run.baseDir, run.workerHost);
  if (refusal) return answer({ kind: 'client-only', reason: refusal });
  const daemon = await readOwnerRegistration(run.baseDir, run.daemonPid);
  if (!daemon) return answer({ kind: 'client-only', reason: 'daemon-registration' });

  const host: HostEnvironment = { env: { ...input.env }, cwd: input.cwd };
  const send = createDaemonTransport(host);
  const transport = createNidusAttachedTransport(
    async (req, options) => {
      run.onDispatch();
      return await send(req, options);
    },
    { host, daemon, stateDir: run.baseDir, signal: run.signal, refuse: refuseCapturedCli },
  );
  const outcome = await runCapturedCli(
    { stdoutIsTTY: input.stdoutIsTTY, stderrIsTTY: input.stderrIsTTY },
    async () => {
      try {
        await runEntryLikeBin(input.argv, host, transport);
      } catch {
        // `bin.ts` exits 1 when the entry itself rejects.
        await capturedCliExit(1);
      }
    },
  );
  return answer(outcome);
}

/** `bin.ts`, with this run's host and the daemon-attached transport. */
async function runEntryLikeBin(
  argv: string[],
  host: HostEnvironment,
  transport: ReturnType<typeof createDaemonTransport>,
): Promise<void> {
  await runEntry(
    argv,
    {
      help: () => import('./commands/schema/cli-help.ts'),
      cli: async () => {
        const [{ runCliProcess }, { runCli }] = await Promise.all([
          import('./cli/process-entry.ts'),
          import('./cli.ts'),
        ]);
        return {
          runCliProcess: (cliArgv) =>
            runCliProcess(cliArgv, host, async () => ({
              runCli: (runArgv, _deps, runHost) =>
                runCli(runArgv, { sendToDaemon: transport }, runHost),
            })),
        };
      },
      mcp: async () => ({ runAgentDeviceMcpServer: () => refuseCapturedCli('command:mcp') }),
      version: () => import('@agent-device/host-kit/version'),
      processExit: () => import('./cli/process-exit.ts'),
    },
    {
      bundledVersion:
        typeof __AGENT_DEVICE_VERSION__ === 'string' ? __AGENT_DEVICE_VERSION__ : undefined,
      stdout: (text) => writeCapturedCli(1, text),
      stderr: (text) => writeCapturedCli(2, text),
    },
  );
}

/**
 * Why this run must stay in the client's process, or undefined when the worker can run it. Each
 * rule names something the Node CLI reads from its own process or does there, which a run in the
 * worker would read or do differently.
 */
function admissionRefusal(
  input: NidusCliArgvInput,
  baseDir: string,
  workerHost: HostEnvironment,
): string | undefined {
  const hostRefusal = hostAdmissionRefusal(input, workerHost);
  if (hostRefusal) return hostRefusal;
  let parsed: ReturnType<typeof resolveCliOptions>;
  try {
    parsed = resolveCliOptions(input.argv, { cwd: input.cwd, env: input.env });
  } catch {
    // The CLI renders its own parse failure; nothing reaches a daemon.
    return undefined;
  }
  const { command, flags } = parsed;
  if (flags.help || flags.version || command === null || command === 'help') return undefined;
  if (!isKnownCliCommandName(command)) return undefined;
  if (!NATIVE_CLI_COMMANDS.has(command)) return `command:${command}`;
  return flagAdmissionRefusal(parsed, input, baseDir);
}

/** What the client's process differs in from the worker's, in ways the CLI run would read. */
function hostAdmissionRefusal(
  input: NidusCliArgvInput,
  workerHost: HostEnvironment,
): string | undefined {
  // An interactive stderr turns on the upgrade notifier, which reads the process environment.
  if (input.stderrIsTTY) return 'stderr-tty';
  // Diagnostics files and temporary artifacts resolve from the worker's home and temp dir, the daemon's.
  if (input.env.HOME !== workerHost.env.HOME) return 'home';
  if (input.env.TMPDIR !== workerHost.env.TMPDIR) return 'tmpdir';
  // A policy mismatch makes the Node CLI replace the daemon.
  if (input.env.AGENT_DEVICE_DAEMON_POLICY !== undefined) return 'daemon-policy';
  return undefined;
}

/** Parsed options that make a native command need the client's process or another daemon. */
function flagAdmissionRefusal(
  parsed: ReturnType<typeof resolveCliOptions>,
  input: NidusCliArgvInput,
  baseDir: string,
): string | undefined {
  const { flags } = parsed;
  // `--debug` tails the daemon log on a timer that a captured exit would never stop.
  if (flags.verbose) return 'debug';
  if (flags.textStdin) return 'stdin';
  if (flags.daemonBaseUrl || flags.remoteConfig || parsed.remoteConfigLeaseProvider) {
    return 'remote';
  }
  if (flags.stepsFile !== undefined && !path.isAbsolute(flags.stepsFile)) {
    return 'relative-steps-file';
  }
  const stateDir = resolveDaemonPaths(flags.stateDir, { env: input.env, cwd: input.cwd }).baseDir;
  if (stateDir !== baseDir) return 'other-state-dir';
  if (fs.existsSync(path.join(stateDir, 'remote-connections'))) return 'remote-connection-state';
  return undefined;
}

async function readOwnerRegistration(
  baseDir: string,
  daemonPid: number,
): Promise<DaemonInfo | null> {
  ownerRegistration ??= readRegisteredDaemon(resolveDaemonPaths(baseDir))
    .then((info) => (info && info.pid === daemonPid ? info : null))
    .catch(() => null);
  const info = await ownerRegistration;
  // A registration not yet published is read again on the next request.
  if (!info) ownerRegistration = undefined;
  return info;
}

function answer(outcome: CapturedCliOutcome): DaemonResponse {
  if (outcome.kind === 'client-only') {
    return { ok: true, data: { outcome: 'client-only', reason: outcome.reason } };
  }
  return {
    ok: true,
    data: { outcome: 'exit', exitCode: outcome.exitCode, output: outcome.output },
  };
}

function readInput(raw: unknown): NidusCliArgvInput {
  if (!isRecord(raw)) throw invalidInput('input');
  const { argv, cwd, env, stdoutIsTTY, stderrIsTTY } = raw;
  if (!Array.isArray(argv) || !argv.every((entry) => typeof entry === 'string')) {
    throw invalidInput('argv');
  }
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw invalidInput('cwd');
  if (!isRecord(env) || !Object.values(env).every((value) => typeof value === 'string')) {
    throw invalidInput('env');
  }
  if (typeof stdoutIsTTY !== 'boolean') throw invalidInput('stdoutIsTTY');
  if (typeof stderrIsTTY !== 'boolean') throw invalidInput('stderrIsTTY');
  return {
    argv: argv as string[],
    cwd,
    env: env as Record<string, string>,
    stdoutIsTTY,
    stderrIsTTY,
  };
}

function invalidInput(field: string): AppError {
  return new AppError('INVALID_ARGS', `Invalid nidus_cli_argv request: ${field}`);
}
