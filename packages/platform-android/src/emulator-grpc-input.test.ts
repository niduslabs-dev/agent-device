import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import {
  DISPATCH_DISCLOSURE_TABLE_PATH,
  assertDispatchDisclosureDriversMatchRows,
  dispatchDisclosureRowsOwnedBy,
} from '@agent-device/test-kit';
import { bindAndroidAdbHostStub } from './adb-host.fixtures.ts';
import type { AndroidAdbInvocation } from './adb-transport.ts';
import { withAndroidAdbProvider } from './adb-provider-scope.ts';
import {
  noteAndroidDisplayOrientation,
  forgetAndroidDisplayOrientation,
} from './snapshot-capture.ts';
import { forgetEmulatorGrpcEndpoint } from './emulator-grpc-endpoint.ts';
import {
  ANDROID_EMULATOR_GRPC_BACKEND,
  ANDROID_EMULATOR_GRPC_INPUT_ENV,
  placeOnEmulatorPanel,
  pressAndroidEmulatorKeyOverGrpc,
  runAndroidEmulatorTouchPlanOverGrpc,
  tapAndroidEmulatorOverGrpc,
} from './emulator-grpc-input.ts';
import { dropEmulatorGrpcConnection } from './emulator-grpc-wire.ts';
import { backAndroid, pressAndroid } from './input-actions.ts';
import type { AndroidLoweredTouchPlan } from './touch-plan-lowering.ts';
import { createAndroidFileHost } from './__tests__/test-utils/android-file-host.ts';
import { mkdtempForTest } from './__tests__/test-utils/tmp-dir.ts';

const EMULATOR: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'dev_android36',
  kind: 'emulator',
  booted: true,
};
const TOKEN = 'emulator-input-test-token';
const PANEL = { width: 1080, height: 2400 };
const GRPC_STATUS_INTERNAL = 13;
const GRPC_STATUS_UNAUTHENTICATED = 16;

type ReceivedCall = { method: string; authorization?: string; message: Buffer };

/** Answers one status per call, in order; once the list runs out every call answers OK. */
type FakeEmulator = {
  port: number;
  calls: ReceivedCall[];
  statuses: number[];
  close: () => Promise<void>;
};

let emulator: FakeEmulator;
let adbCalls: AndroidAdbInvocation[];
let environment: Record<string, string | undefined>;

async function startFakeEmulator(): Promise<FakeEmulator> {
  const calls: ReceivedCall[] = [];
  const statuses: number[] = [];
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      const body = Buffer.concat(chunks);
      const method = String(headers[':path']).split('/').at(-1)!;
      calls.push({
        method,
        authorization: headers.authorization,
        message: body.subarray(5),
      });
      const status = statuses.shift() ?? 0;
      stream.respond(
        { ':status': 200, 'content-type': 'application/grpc' },
        { waitForTrailers: true },
      );
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': String(status) }));
      stream.end(status === 0 ? replyFor(method) : Buffer.alloc(0));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    calls,
    statuses,
    close: async () => await new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** `DisplayConfigurations { displays: [{ width: 1080, height: 2400 }] }`; every other reply is Empty. */
function replyFor(method: string): Buffer {
  const message =
    method === 'getDisplayConfigurations'
      ? Buffer.from([0x0a, 0x06, 0x08, 0xb8, 0x08, 0x10, 0xe0, 0x12])
      : Buffer.alloc(0);
  const frame = Buffer.alloc(5);
  frame.writeUInt32BE(message.length, 1);
  return Buffer.concat([frame, message]);
}

/** Field number to value for the varint fields of one flat protobuf message. */
function varintFields(message: Buffer): Record<number, number> {
  const fields: Record<number, number> = {};
  let offset = 0;
  const read = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = message[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7;
    }
  };
  while (offset < message.length) {
    const tag = read();
    if (tag % 8 === 2) {
      offset += read();
      continue;
    }
    fields[Math.floor(tag / 8)] = read();
  }
  return fields;
}

function mouseCalls(): Array<{ x: number; y: number; buttons: number }> {
  return emulator.calls
    .filter((call) => call.method === 'sendMouse')
    .map((call) => {
      const fields = varintFields(call.message);
      return { x: fields[1] ?? 0, y: fields[2] ?? 0, buttons: fields[3] ?? 0 };
    });
}

beforeEach(async () => {
  emulator = await startFakeEmulator();
  const home = await mkdtempForTest('emulator-grpc-input-');
  const directory = path.join(home, 'Library', 'Caches', 'TemporaryItems', 'avd', 'running');
  await fsPromises.mkdir(directory, { recursive: true });
  // This test process stands in for the emulator, so its own PID is the live registrant.
  await fsPromises.writeFile(
    path.join(directory, `pid_${process.pid}.ini`),
    [
      'avd.name=dev_android36',
      'port.serial=5554',
      `grpc.port=${emulator.port}`,
      `grpc.token=${TOKEN}`,
    ].join('\n'),
  );
  adbCalls = [];
  environment = { HOME: home };
  bindAndroidAdbHostStub({
    environment,
    files: createAndroidFileHost(),
    execAdb: async (invocation) => {
      adbCalls.push(invocation);
      return invocation.command[0] === 'emu'
        ? { stdout: 'dev_android36\r\nOK\r\n', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  forgetEmulatorGrpcEndpoint(EMULATOR.id);
  forgetAndroidDisplayOrientation(EMULATOR);
});

afterEach(async () => {
  dropEmulatorGrpcConnection(emulator.port);
  await emulator.close();
  vi.restoreAllMocks();
});

function deviceCommands(): string[][] {
  return adbCalls.map((call) => [...call.command]).filter((command) => command[0] !== 'emu');
}

test('a point read in each rotation lands on the same panel pixel', () => {
  const natural = { x: 100, y: 300 };
  // The same physical spot, as the display reports it in each rotation.
  const reads = [
    { rotation: 0, width: 1080, height: 2400, point: { x: 100, y: 300 } },
    { rotation: 1, width: 2400, height: 1080, point: { x: 300, y: 979 } },
    { rotation: 2, width: 1080, height: 2400, point: { x: 979, y: 2099 } },
    { rotation: 3, width: 2400, height: 1080, point: { x: 2099, y: 100 } },
  ] as const;
  for (const read of reads) {
    const place = placeOnEmulatorPanel(read, PANEL);
    assert.ok(place, `rotation ${read.rotation}`);
    assert.deepEqual(place(read.point.x, read.point.y), natural, `rotation ${read.rotation}`);
  }
});

test('a display that is not the whole panel has no placement', () => {
  assert.equal(placeOnEmulatorPanel({ rotation: 0, width: 1080, height: 1200 }, PANEL), undefined);
  assert.equal(placeOnEmulatorPanel({ rotation: 1, width: 1080, height: 2400 }, PANEL), undefined);
});

test('back goes to the emulator as GoBack with its bearer token and no adb input', async () => {
  await backAndroid(EMULATOR);

  assert.deepEqual(
    emulator.calls.map((call) => [call.method, call.authorization]),
    [['sendKey', `Bearer ${TOKEN}`]],
  );
  assert.ok(emulator.calls[0]!.message.includes(Buffer.from('GoBack')));
  assert.deepEqual(deviceCommands(), []);
});

test('a key the emulator does not name stays off the gRPC route', async () => {
  assert.equal(await pressAndroidEmulatorKeyOverGrpc(EMULATOR, 24), 'unavailable');
  assert.equal(emulator.calls.length, 0);
});

test('press taps over gRPC once a capture has placed the display', async () => {
  noteAndroidDisplayOrientation(EMULATOR, {
    displayRotation: 1,
    displayWidth: 2400,
    displayHeight: 1080,
  });

  await pressAndroid(EMULATOR, 300, 979);

  assert.deepEqual(mouseCalls(), [
    { x: 100, y: 300, buttons: 1 },
    { x: 100, y: 300, buttons: 0 },
  ]);
  assert.deepEqual(deviceCommands(), []);
});

test('press keeps the adb route while no capture has placed the display', async () => {
  await pressAndroid(EMULATOR, 300, 979);

  assert.equal(emulator.calls.length, 0);
  assert.deepEqual(deviceCommands(), [['shell', 'input', 'tap', '300', '979']]);
});

test('a refused first call falls back once and the endpoint is looked up again', async () => {
  emulator.statuses.push(GRPC_STATUS_UNAUTHENTICATED);

  await backAndroid(EMULATOR);

  assert.deepEqual(deviceCommands(), [['shell', 'input', 'keyevent', '4']]);
  await backAndroid(EMULATOR);
  assert.equal(emulator.calls.length, 2);
  assert.equal(adbCalls.filter((call) => call.command[0] === 'emu').length, 2);
});

test('the operator switch and a provider scope both keep the existing route', async () => {
  environment[ANDROID_EMULATOR_GRPC_INPUT_ENV] = '0';
  assert.equal(await pressAndroidEmulatorKeyOverGrpc(EMULATOR, 4), 'unavailable');
  delete environment[ANDROID_EMULATOR_GRPC_INPUT_ENV];

  const providerExec = async () => ({ stdout: '', stderr: '', exitCode: 0 });
  await withAndroidAdbProvider(providerExec, { serial: EMULATOR.id }, async () => {
    assert.equal(await pressAndroidEmulatorKeyOverGrpc(EMULATOR, 4), 'unavailable');
  });
  assert.equal(emulator.calls.length, 0);
});

test('a swipe plays its samples in order and lifts at the last one', async () => {
  noteAndroidDisplayOrientation(EMULATOR, {
    displayRotation: 0,
    displayWidth: 1080,
    displayHeight: 2400,
  });
  const plan = swipePlan([
    { offsetMs: 0, point: { x: 540, y: 1800 } },
    { offsetMs: 8, point: { x: 540, y: 1500 } },
    { offsetMs: 16, point: { x: 540, y: 1200 } },
  ]);

  const result = await runAndroidEmulatorTouchPlanOverGrpc(EMULATOR, plan);

  assert.equal(result?.backend, ANDROID_EMULATOR_GRPC_BACKEND);
  assert.deepEqual(mouseCalls(), [
    { x: 540, y: 1800, buttons: 1 },
    { x: 540, y: 1500, buttons: 1 },
    { x: 540, y: 1200, buttons: 1 },
    { x: 540, y: 1200, buttons: 0 },
  ]);
});

test('a multi-touch plan is left to the helper', async () => {
  noteAndroidDisplayOrientation(EMULATOR, {
    displayRotation: 0,
    displayWidth: 1080,
    displayHeight: 2400,
  });
  const plan = {
    topology: 'multi',
    intent: 'pinch',
    durationMs: 100,
    pointers: [],
  } as unknown as AndroidLoweredTouchPlan;
  assert.equal(await runAndroidEmulatorTouchPlanOverGrpc(EMULATOR, plan), undefined);
  assert.equal(emulator.calls.length, 0);
});

function swipePlan(
  samples: Array<{ offsetMs: number; point: { x: number; y: number } }>,
): AndroidLoweredTouchPlan {
  return {
    topology: 'single',
    intent: 'pan',
    durationMs: samples.at(-1)!.offsetMs,
    pointers: [{ pointerId: 0, samples }],
  } as unknown as AndroidLoweredTouchPlan;
}

const DISPATCH_DRIVERS: Record<string, () => Promise<unknown>> = {
  'android-emulator-grpc.key.failed-after-send': async () => {
    emulator.statuses.push(GRPC_STATUS_INTERNAL);
    return await pressAndroidEmulatorKeyOverGrpc(EMULATOR, 4);
  },
  'android-emulator-grpc.tap.release-failed': async () => {
    noteAndroidDisplayOrientation(EMULATOR, {
      displayRotation: 0,
      displayWidth: 1080,
      displayHeight: 2400,
    });
    // The panel read and the touch down succeed; the lift fails.
    emulator.statuses.push(0, 0, GRPC_STATUS_INTERNAL);
    try {
      return await tapAndroidEmulatorOverGrpc(EMULATOR, 10, 10);
    } finally {
      // The finger is lifted again after the failure, so the touchscreen is never left held.
      assert.deepEqual(mouseCalls().at(-1), { x: 10, y: 10, buttons: 0 });
    }
  },
};

const DISPATCH_ROWS = dispatchDisclosureRowsOwnedBy(
  import.meta.url,
  fs.readFileSync(DISPATCH_DISCLOSURE_TABLE_PATH, 'utf8'),
);

test('every emulator gRPC dispatch-disclosure row has exactly one driver', () => {
  assertDispatchDisclosureDriversMatchRows(DISPATCH_ROWS, Object.keys(DISPATCH_DRIVERS));
});

for (const row of DISPATCH_ROWS) {
  test(`${row.id}: ${row.trigger} → dispatched ${row.dispatched}`, async () => {
    const drive = DISPATCH_DRIVERS[row.id];
    assert.ok(drive, `no driver for ${row.id}`);
    await assert.rejects(drive(), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.dispatched, row.dispatched);
      assert.equal(error.details?.reason, 'android_emulator_grpc_input_failed');
      return true;
    });
  });
}
