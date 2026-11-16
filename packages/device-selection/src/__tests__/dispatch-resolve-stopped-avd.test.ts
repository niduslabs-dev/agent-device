import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { resolveTargetDevice as resolveTargetDeviceInContext } from '../dispatch-resolve.ts';
import { withTestDeviceInventory } from '../inventory-gateways.fixtures.ts';

const androidEmulator: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel_9_Pro_XL',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

const stoppedAvd: DeviceInfo = {
  platform: 'android',
  id: 'dev_android36',
  name: 'dev_android36',
  kind: 'emulator',
  target: 'mobile',
  booted: false,
};

async function resolveAgainstAndroidAvds(
  flags: Parameters<typeof resolveTargetDeviceInContext>[0],
  options: Partial<Parameters<typeof resolveTargetDeviceInContext>[1]> = {},
): Promise<DeviceInfo> {
  return await withTestDeviceInventory(
    {
      local: async (request) =>
        request.androidAvdSelection === 'running-only'
          ? [androidEmulator]
          : [androidEmulator, stoppedAvd],
    },
    async () => await resolveTargetDeviceInContext(flags, { env: process.env, ...options }),
  );
}

test.each(['dev_android36', 'dev android36', 'DEV_Android36'])(
  'a running-only command naming stopped AVD %j fails as not booted with the boot command',
  async (deviceName) => {
    await assert.rejects(
      () => resolveAgainstAndroidAvds({ device: deviceName }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'DEVICE_NOT_FOUND');
        assert.equal(error.details?.reason, 'device_not_booted');
        assert.equal(error.details?.device, 'dev_android36');
        assert.match(
          String(error.details?.hint),
          /agent-device boot --device "dev_android36" --platform android/,
        );
        return true;
      },
    );
  },
);

test('a name that matches no running or stopped device keeps the plain not-found error', async () => {
  await assert.rejects(
    () => resolveAgainstAndroidAvds({ platform: 'android', device: 'missing_avd' }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'DEVICE_NOT_FOUND');
      assert.equal(error.details?.reason, undefined);
      return true;
    },
  );
});

test('a command that includes stopped AVDs still selects the stopped AVD by name', async () => {
  const device = await resolveAgainstAndroidAvds(
    { platform: 'android', device: 'dev android36' },
    { androidAvdSelection: 'include-stopped' },
  );
  assert.equal(device.id, stoppedAvd.id);
});
