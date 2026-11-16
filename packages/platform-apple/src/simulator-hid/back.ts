import type { AppleRunnerCommandOptions } from '@agent-device/apple-runner';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { runAppleRunnerCommand } from '../core/runner-client.ts';
import {
  admitsSimulatorHidDevice,
  type SimulatorHidTapTarget,
  tapThroughSimulatorHid,
} from './client.ts';

/**
 * iOS `back` through the runner. On a local Simulator the back button tap goes to the digitizer,
 * not XCTest (ADR 0005): the runner looks the button up and answers its point instead of tapping
 * it, the host taps it, and the runner confirms the pop against the state it read before the tap.
 * A lookup that finds no button to press runs the rest of the back in that request, the swipe
 * included. A host tap that sends nothing gives the whole back back to the runner; a host tap that
 * may have been sent but was not confirmed throws, and nothing repeats it.
 */
export async function runIosInAppBack(
  device: DeviceInfo,
  appBundleId: string | undefined,
  runnerOpts: AppleRunnerCommandOptions,
): Promise<void> {
  if (!admitsSimulatorHidDevice(device)) {
    await runAppleRunnerCommand(device, { command: 'backInApp', appBundleId }, runnerOpts);
    return;
  }
  const lookup = await runAppleRunnerCommand(
    device,
    { command: 'backInApp', appBundleId, backInAppPhase: 'hostTapLookup' },
    runnerOpts,
  );
  const target = readHostBackTap(lookup);
  if (!target) return;
  if (await tapThroughSimulatorHid(device, target, runnerOpts.signal)) {
    await runAppleRunnerCommand(
      device,
      { command: 'backInApp', appBundleId, backInAppPhase: 'hostTapConfirm' },
      runnerOpts,
    );
    return;
  }
  await runAppleRunnerCommand(device, { command: 'backInApp', appBundleId }, runnerOpts);
}

/**
 * The point a `hostTapLookup` answered, or undefined when the runner finished the back itself. A
 * point that cannot be read leaves a lookup that tapped nothing, so it fails with nothing sent.
 */
function readHostBackTap(
  result: Readonly<Record<string, unknown>>,
): SimulatorHidTapTarget | undefined {
  const tap = result.hostBackTap;
  if (tap === undefined) return undefined;
  const { x, y, viewportWidth, viewportHeight } =
    tap !== null && typeof tap === 'object' ? (tap as Record<string, unknown>) : {};
  if (![x, y, viewportWidth, viewportHeight].every(isFiniteNumber)) {
    throw new AppError('COMMAND_FAILED', 'back found the back button but got no point to tap.', {
      reason: 'back_host_tap_point_unreadable',
      dispatched: 'no',
      hint: 'Retry back.',
    });
  }
  return {
    point: { x: x as number, y: y as number },
    viewport: { width: viewportWidth as number, height: viewportHeight as number },
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
