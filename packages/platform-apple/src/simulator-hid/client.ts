import type { CoordinateTapTextInputEvidence } from '@agent-device/contracts/interactor-types';
import { commandDeveloperDir, runCmd, runCmdBackground } from '@agent-device/host-kit/command';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { runnerSynthesizesTap } from '@agent-device/kernel/device';
import { ensureSimulatorHidHelperBinary } from './helper-cache.ts';

/** Startup covers the helper's own 4 s liveness probe of a demand-launched `dtuhidd`. */
const HELPER_READY_TIMEOUT_MS = 8_000;
/** A tap answers within its 1 s barrier, so a reply later than this means the helper is stuck. */
const TAP_REPLY_TIMEOUT_MS = 2_500;
const HID_PHASE = 'ios.simulator-hid';

type HelperReply = Readonly<Record<string, unknown>>;

type HelperSession = Readonly<{
  request: (payload: Record<string, unknown>) => Promise<HelperReply>;
}>;

const sessions = new Map<string, Promise<HelperSession | undefined>>();
/** The helper process serving each device's ready session; a session forgets only its own helper. */
const helpers = new Map<string, unknown>();

/**
 * Whether a primary single tap on `device` may skip XCTest and go to the Simulator's digitizer.
 * Only a local iOS-family Simulator, only with the capture evidence that proves the point is not
 * in a text input (a text-field tap needs the runner's focus witness for a later bare `type`), and
 * only when that capture gives the app's root rect.
 */
export function admitsSimulatorHidTap(
  device: DeviceInfo,
  evidence: CoordinateTapTextInputEvidence | undefined,
): evidence is CoordinateTapTextInputEvidence & {
  viewport: NonNullable<CoordinateTapTextInputEvidence['viewport']>;
} {
  if (device.kind !== 'simulator' || device.simulatorSetPath || !runnerSynthesizesTap(device))
    return false;
  if (!evidence?.viewport) return false;
  const { x, y } = evidence.point;
  return !evidence.textInputRects.some(
    (rect) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height,
  );
}

/**
 * Taps `evidence.point` through the Simulator's digitizer. Resolves `true` once the guest's HID
 * daemon has taken the touch, `false` when the direct route is unavailable and nothing was sent,
 * so the caller keeps the XCTest tap. Throws when the touch may have been sent but was not
 * confirmed, because repeating it through XCTest could tap twice.
 */
export async function tapThroughSimulatorHid(
  device: DeviceInfo,
  evidence: CoordinateTapTextInputEvidence & {
    viewport: NonNullable<CoordinateTapTextInputEvidence['viewport']>;
  },
  signal?: AbortSignal,
): Promise<boolean> {
  const session = await openSession(device, signal);
  if (!session) return false;
  const reply = await session.request({
    x: evidence.point.x,
    y: evidence.point.y,
    viewportWidth: evidence.viewport.width,
    viewportHeight: evidence.viewport.height,
  });
  if (reply.ok === true) {
    emitDiagnostic({
      level: 'debug',
      phase: HID_PHASE,
      data: { event: 'tap', elapsedMs: reply.elapsedMs },
    });
    return true;
  }
  emitDiagnostic({ level: 'debug', phase: HID_PHASE, data: { event: 'tap-refused', ...reply } });
  if (reply.dispatched === true) {
    throw new AppError('COMMAND_FAILED', 'The simulator touch was sent but not confirmed.', {
      reason: 'simulator-hid-outcome-unknown',
      hint: 'Take a snapshot before you press again: the tap may have landed.',
    });
  }
  return false;
}

function openSession(device: DeviceInfo, signal?: AbortSignal): Promise<HelperSession | undefined> {
  let session = sessions.get(device.id);
  if (!session) {
    session = startSession(device, signal).catch((error: unknown) => {
      emitDiagnostic({
        level: 'warn',
        phase: HID_PHASE,
        data: {
          event: 'unavailable',
          message: error instanceof Error ? error.message : String(error),
        },
      });
      return undefined;
    });
    sessions.set(device.id, session);
  }
  return session;
}

async function startSession(
  device: DeviceInfo,
  signal?: AbortSignal,
): Promise<HelperSession | undefined> {
  const binary = await ensureSimulatorHidHelperBinary(signal);
  const developerDir =
    commandDeveloperDir() ?? (await runCmd('xcode-select', ['-p'], { signal })).stdout.trim();
  const { child, wait } = runCmdBackground(binary, [developerDir, device.id], {
    stdio: ['pipe', 'pipe', 'pipe'],
    captureOutput: false,
    allowFailure: true,
  });
  child.unref();
  const forget = () => {
    if (helpers.get(device.id) !== child) return;
    helpers.delete(device.id);
    sessions.delete(device.id);
  };
  void wait.then(forget, forget);

  const lines: string[] = [];
  const waiters: Array<(line: string | undefined) => void> = [];
  let buffered = '';
  let closed = false;
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffered += chunk;
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
      newline = buffered.indexOf('\n');
    }
  });
  child.stdout?.once('close', () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter(undefined);
  });
  child.stderr?.resume();
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    (stream as { unref?: () => void } | null)?.unref?.();
  }

  const nextLine = (timeoutMs: number) =>
    new Promise<string | undefined>((resolve) => {
      const ready = lines.shift();
      if (ready !== undefined || closed) {
        resolve(ready);
        return;
      }
      const timer = setTimeout(() => {
        const index = waiters.indexOf(settle);
        if (index >= 0) waiters.splice(index, 1);
        resolve(undefined);
      }, timeoutMs);
      const settle = (line: string | undefined) => {
        clearTimeout(timer);
        resolve(line);
      };
      waiters.push(settle);
    });
  const parse = (line: string | undefined): HelperReply | undefined => {
    if (line === undefined) return undefined;
    try {
      const value: unknown = JSON.parse(line);
      return value && typeof value === 'object' ? (value as HelperReply) : undefined;
    } catch {
      return undefined;
    }
  };

  const ready = parse(await nextLine(HELPER_READY_TIMEOUT_MS));
  if (ready?.ready !== true) {
    child.kill();
    throw new Error(`simulator HID helper did not start: ${String(ready?.reason ?? 'no reply')}`);
  }
  emitDiagnostic({ level: 'debug', phase: HID_PHASE, data: { event: 'ready', ...ready } });

  let queue: Promise<unknown> = Promise.resolve();
  const request = (payload: Record<string, unknown>): Promise<HelperReply> => {
    const run = queue.then(async () => {
      child.stdin?.write(`${JSON.stringify(payload)}\n`);
      const reply = parse(await nextLine(TAP_REPLY_TIMEOUT_MS));
      if (reply) return reply;
      child.kill();
      forget();
      // The line may have been read and the touch sent, so this is not a refusal.
      return { ok: false, dispatched: true, reason: 'helper-no-reply' };
    });
    queue = run.catch(() => undefined);
    return run;
  };
  helpers.set(device.id, child);
  return { request };
}
