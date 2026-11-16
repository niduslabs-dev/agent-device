import { expect, test } from 'vitest';
import type { CoordinateTapTextInputEvidence } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { admitsSimulatorHidTap } from './client.ts';

const simulator: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'sim-1',
  name: 'iPhone 18 Pro',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

const evidence: CoordinateTapTextInputEvidence = {
  targetBundleId: 'com.example.app',
  point: { x: 60, y: 40 },
  textInputRects: [{ x: 10, y: 120, width: 100, height: 40 }],
  viewport: { width: 402, height: 874 },
};

test('a tap away from every text input on a local iOS simulator goes to the digitizer', () => {
  expect(admitsSimulatorHidTap(simulator, evidence)).toBe(true);
});

test('a tap inside a text input keeps XCTest, which books the focus witness for a later type', () => {
  expect(admitsSimulatorHidTap(simulator, { ...evidence, point: { x: 60, y: 140 } })).toBe(false);
});

test('without capture evidence or its viewport the tap keeps XCTest', () => {
  expect(admitsSimulatorHidTap(simulator, undefined)).toBe(false);
  const { viewport: _viewport, ...withoutViewport } = evidence;
  expect(admitsSimulatorHidTap(simulator, withoutViewport)).toBe(false);
});

test('a physical iPhone, a tvOS simulator, and a custom simulator set keep XCTest', () => {
  expect(admitsSimulatorHidTap({ ...simulator, kind: 'device' }, evidence)).toBe(false);
  expect(admitsSimulatorHidTap({ ...simulator, appleOs: 'tvos', target: 'tv' }, evidence)).toBe(
    false,
  );
  expect(admitsSimulatorHidTap({ ...simulator, simulatorSetPath: '/tmp/set' }, evidence)).toBe(
    false,
  );
});
