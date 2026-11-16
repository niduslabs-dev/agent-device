/**
 * The text snapshot header names the unit its frames are in. The unit comes from the capture's
 * backend, so the backend has to survive the whole argv -> client -> daemon -> runtime -> CLI
 * formatter chain; a formatter-only test passes while live snapshots print no unit.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceClient, CommandName } from '@agent-device/command-surface';
import { runCliCommandWithOutput } from '../../../src/commands/cli-runner.ts';
import { parseArgs } from '../../../src/cli/parser/args.ts';
import { createAndroidSettingsWorld } from './android-world.ts';
import { FIRST_SCREEN_NODES, PROVIDER_SCENARIO_IOS_SIMULATOR } from './fixtures.ts';
import { createProviderScenarioHarness, withProviderScenarioResource } from './harness.ts';
import { createRecordingAppleToolProvider } from './providers.ts';

async function cliSnapshotText(
  client: AgentDeviceClient,
  argv: string[],
  selection: Record<string, unknown>,
): Promise<{ text: string; json: Record<string, unknown> }> {
  const parsed = parseArgs(argv, { strictFlags: true });
  const { cliOutput } = await runCliCommandWithOutput({
    client,
    command: argv[0] as CommandName,
    positionals: parsed.positionals,
    flags: { ...parsed.flags, ...selection },
    env: process.env,
  });
  assert.ok(cliOutput?.text, 'snapshot must render text output');
  return { text: cliOutput.text, json: (cliOutput.jsonData ?? cliOutput.data) as never };
}

test('an Android CLI snapshot header states frames in px', async () => {
  await withProviderScenarioResource(createAndroidSettingsWorld, async (world) => {
    const client = world.daemon.client();
    await client.apps.open({ app: 'settings', ...world.selection });
    for (const argv of [['snapshot'], ['snapshot', '-i']]) {
      const { text, json } = await cliSnapshotText(client, argv, world.selection);
      assert.match(text, /^Snapshot: .*; frames \(x,y,w,h\) in px$/m, text);
      assert.equal(json.backend, 'android');
    }
  });
});

test('an iOS CLI snapshot header states frames in points', async () => {
  const appleTool = createRecordingAppleToolProvider({
    simctl: async (args) => {
      if (args[0] === 'list') {
        return {
          stdout: JSON.stringify({
            devices: {
              'iOS 18.5': [{ udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id, state: 'Booted' }],
            },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'launch') return { stdout: '', stderr: '', exitCode: 0 };
      throw new Error(`Unexpected Apple simulator call: ${args.join(' ')}`);
    },
  });
  const daemon = await createProviderScenarioHarness({
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_IOS_SIMULATOR],
    appleToolProvider: () => appleTool.provider,
    appleRunnerProvider: () => ({
      hasLiveSession: () => true,
      runCommand: async (_device, command) => {
        assert.equal(command.command, 'snapshot');
        return { nodes: FIRST_SCREEN_NODES };
      },
    }),
  });
  try {
    const selection = { platform: 'ios' as const, udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id };
    await daemon.client().apps.open({ app: 'com.example.demo', ...selection });
    const { text, json } = await cliSnapshotText(daemon.client(), ['snapshot', '-i'], selection);
    assert.match(text, /^Snapshot: .*; frames \(x,y,w,h\) in points$/m, text);
    assert.equal(json.backend, 'xctest');
  } finally {
    await daemon.close();
  }
});
