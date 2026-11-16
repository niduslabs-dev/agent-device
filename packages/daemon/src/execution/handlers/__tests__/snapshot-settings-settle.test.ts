import { beforeEach, expect, test } from 'vitest';
import type { DaemonCommandSurface } from '@agent-device/contracts/daemon-command-surface';
import type { SettleObservation } from '@agent-device/contracts/interaction';
import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';
import { commandSurfaceWithMembers } from '../../../__tests__/support/command-surface-override-fake.ts';
import {
  fixtureSettingsMutations,
  resetSnapshotRuntimeFixture,
  snapshotRuntimeFixture,
} from '../../../__tests__/support/snapshot-runtime-fixture.ts';
import {
  androidDevice,
  makeSession,
  makeSessionStore,
  snapshotRequest,
} from '../../../__tests__/support/handlers/snapshot-handler.fixtures.ts';
import { activateCompleteRefFrame } from '../../../core/ref-frame.ts';
import { handleSettingsCommand, parseSettingsArgs } from '../snapshot-settings.ts';

type SettleObservationOptions = Parameters<
  DaemonCommandSurface['interactions']['settleObservation']
>[0];

const SETTLED: SettleObservation = {
  settled: true,
  waitedMs: 600,
  captures: 2,
  quietMs: 500,
  timeoutMs: 10_000,
};

/** Each settle call with the number of setting writes the owner had received when it started. */
const settleCalls: Array<{ options: SettleObservationOptions; mutationsSoFar: number }> = [];

const createCommandSurface = commandSurfaceWithMembers(() => ({
  interactions: {
    settleObservation: async (options) => {
      settleCalls.push({ options, mutationsSoFar: fixtureSettingsMutations.length });
      return SETTLED;
    },
  },
}));

beforeEach(() => {
  resetSnapshotRuntimeFixture();
  settleCalls.length = 0;
});

async function runSettings(positionals: string[], withSession: boolean) {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-settings-settle';
  const session = makeSession(sessionName, androidDevice);
  activateCompleteRefFrame(session);
  const ref = sessionStore.publish(sessionName, session);
  const req = snapshotRequest(sessionName, 'settings', { positionals });
  const parsed = parseSettingsArgs(req);
  if (!parsed.ok) throw new Error('expected parsed settings');
  const runtime = snapshotRuntimeFixture();
  return await handleSettingsCommand({
    req,
    createCommandSurface,
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
    ref: withSession ? ref : undefined,
    device: androidDevice,
    parsed: parsed.parsed,
    inspectFacts: runtime.inspectFacts,
    bindDevice: runtime.bindDevice,
    platformServices: daemonPlatformServicesFixture(),
  });
}

test.each([
  ['appearance', 'dark'],
  ['text-size', 'large'],
])(
  'settings %s %s in a session waits for the UI to settle after the write',
  async (setting, state) => {
    const response = await runSettings([setting, state], true);

    expect(response.ok).toBe(true);
    expect(response.ok && response.data.settle).toEqual(SETTLED);
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]?.mutationsSoFar).toBe(1);
    expect(settleCalls[0]?.options.session).toBe('android-settings-settle');
  },
);

test('settings that do not redraw the UI answer without a settle wait', async () => {
  const response = await runSettings(['wifi', 'on'], true);

  expect(response.ok).toBe(true);
  expect(response.ok && response.data.settle).toBeUndefined();
  expect(settleCalls).toHaveLength(0);
  expect(fixtureSettingsMutations).toHaveLength(1);
});

test('settings appearance without a session answers without a settle wait', async () => {
  const response = await runSettings(['appearance', 'dark'], false);

  expect(response.ok).toBe(true);
  expect(response.ok && response.data.settle).toBeUndefined();
  expect(settleCalls).toHaveLength(0);
  expect(fixtureSettingsMutations).toHaveLength(1);
});
