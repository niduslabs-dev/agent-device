import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

vi.mock('../core/runner-client.ts', () => ({ runAppleRunnerCommand: vi.fn() }));
vi.mock('./client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client.ts')>()),
  tapThroughSimulatorHid: vi.fn(),
}));

const { runAppleRunnerCommand } = await import('../core/runner-client.ts');
const { tapThroughSimulatorHid } = await import('./client.ts');
const { runIosInAppBack } = await import('./back.ts');

const runner = vi.mocked(runAppleRunnerCommand);
const hidTap = vi.mocked(tapThroughSimulatorHid);

const simulator: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'sim-1',
  name: 'iPhone 18 Pro',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

const hostBackTap = { x: 30, y: 85, viewportWidth: 402, viewportHeight: 874 };

beforeEach(() => {
  runner.mockReset();
  hidTap.mockReset();
});

function phases(): unknown[] {
  return runner.mock.calls.map(([, command]) => command.backInAppPhase ?? 'complete');
}

test('a simulator back taps the looked-up button through the digitizer, then confirms the pop', async () => {
  runner.mockResolvedValueOnce({ hostBackTap }).mockResolvedValueOnce({ message: 'backInApp' });
  hidTap.mockResolvedValueOnce(true);

  await runIosInAppBack(simulator, 'com.apple.Preferences', {});

  expect(phases()).toEqual(['hostTapLookup', 'hostTapConfirm']);
  expect(hidTap).toHaveBeenCalledWith(
    simulator,
    { point: { x: 30, y: 85 }, viewport: { width: 402, height: 874 } },
    undefined,
  );
});

test('a lookup that finished the back itself, such as by the swipe, sends no tap and no confirmation', async () => {
  runner.mockResolvedValueOnce({ message: 'backInApp' });

  await runIosInAppBack(simulator, 'com.apple.Preferences', {});

  expect(phases()).toEqual(['hostTapLookup']);
  expect(hidTap).not.toHaveBeenCalled();
});

test('a digitizer that sent nothing hands the whole back to the runner, with no confirmation of a tap', async () => {
  runner.mockResolvedValueOnce({ hostBackTap }).mockResolvedValueOnce({ message: 'backInApp' });
  hidTap.mockResolvedValueOnce(false);

  await runIosInAppBack(simulator, 'com.apple.Preferences', {});

  expect(phases()).toEqual(['hostTapLookup', 'complete']);
});

test('a digitizer tap that may have landed fails without a confirmation or a second tap', async () => {
  runner.mockResolvedValueOnce({ hostBackTap });
  const unknown = new AppError('COMMAND_FAILED', 'sent but not confirmed', {
    reason: 'simulator-hid-outcome-unknown',
  });
  hidTap.mockRejectedValueOnce(unknown);

  await expect(runIosInAppBack(simulator, 'com.apple.Preferences', {})).rejects.toBe(unknown);
  expect(phases()).toEqual(['hostTapLookup']);
});

test('an unreadable button point fails as not dispatched instead of reporting a back', async () => {
  runner.mockResolvedValueOnce({ hostBackTap: { x: 30, y: 'top' } });

  await expect(runIosInAppBack(simulator, 'com.apple.Preferences', {})).rejects.toMatchObject({
    details: { reason: 'back_host_tap_point_unreadable', dispatched: 'no' },
  });
  expect(hidTap).not.toHaveBeenCalled();
});

test('a physical iPhone and a custom simulator set run the whole back in the runner', async () => {
  runner.mockResolvedValue({ message: 'backInApp' });

  await runIosInAppBack({ ...simulator, kind: 'device' }, 'com.apple.Preferences', {});
  await runIosInAppBack(
    { ...simulator, simulatorSetPath: '/tmp/set' },
    'com.apple.Preferences',
    {},
  );

  expect(phases()).toEqual(['complete', 'complete']);
  expect(hidTap).not.toHaveBeenCalled();
});
