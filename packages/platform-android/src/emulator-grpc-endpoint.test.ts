import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { inspect } from 'node:util';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { bindAndroidAdbHostStub } from './adb-host.fixtures.ts';
import type { AndroidAdbInvocation } from './adb-transport.ts';
import {
  emulatorConsolePortFromSerial,
  emulatorRegistrationDirectories,
  parseEmulatorRegistration,
  forgetEmulatorGrpcEndpoint,
  resolveEmulatorGrpcEndpoint,
} from './emulator-grpc-endpoint.ts';
import { createAndroidFileHost } from './__tests__/test-utils/android-file-host.ts';
import { mkdtempForTest } from './__tests__/test-utils/tmp-dir.ts';

const livePids = new Set<number>();

vi.mock('@agent-device/host-kit/process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/process')>()),
  isProcessAlive: (pid: number) => livePids.has(pid),
}));

const EMULATOR: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'dev_android36',
  kind: 'emulator',
  booted: true,
};

const TOKEN = 'secret-token-value';

function registrationText(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

const REGISTRATION = {
  'emulator.build': '16740729',
  'avd.id': 'dev_android36',
  'port.serial': '5554',
  'port.adb': '5555',
  'avd.name': 'dev_android36',
  'grpc.token': TOKEN,
  'grpc.port': '8554',
};

let home: string;
let consoleCalls: AndroidAdbInvocation[];
let consoleAvdName: string | undefined;

async function writeRegistration(pid: number, fields: Record<string, string>): Promise<void> {
  const directory = path.join(home, 'Library', 'Caches', 'TemporaryItems', 'avd', 'running');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `pid_${pid}.ini`), registrationText(fields));
}

beforeEach(async () => {
  home = await mkdtempForTest('emulator-grpc-endpoint-');
  consoleCalls = [];
  consoleAvdName = 'dev_android36';
  livePids.clear();
  forgetEmulatorGrpcEndpoint(EMULATOR.id);
  bindAndroidAdbHostStub({
    environment: { HOME: home },
    files: createAndroidFileHost(),
    execAdb: async (invocation) => {
      consoleCalls.push(invocation);
      return consoleAvdName === undefined
        ? { stdout: '', stderr: 'error: device offline', exitCode: 1 }
        : { stdout: `${consoleAvdName}\r\nOK\r\n`, stderr: '', exitCode: 0 };
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('only an emulator-<port> serial names a console port', () => {
  assert.equal(emulatorConsolePortFromSerial('emulator-5554'), 5554);
  assert.equal(emulatorConsolePortFromSerial('emulator-5556'), 5556);
  assert.equal(emulatorConsolePortFromSerial('emulator-'), undefined);
  assert.equal(emulatorConsolePortFromSerial('emulator-5554:5555'), undefined);
  assert.equal(emulatorConsolePortFromSerial('R58M12345'), undefined);
  assert.equal(emulatorConsolePortFromSerial('127.0.0.1:5555'), undefined);
});

test('registration directories cover every host OS the emulator registers on, macOS first', () => {
  assert.deepEqual(
    emulatorRegistrationDirectories({ HOME: '/home/a', XDG_RUNTIME_DIR: '/run/user/1000' }),
    [
      '/home/a/Library/Caches/TemporaryItems/avd/running',
      '/run/user/1000/avd/running',
      '/home/a/.android/avd/running',
    ],
  );
  assert.deepEqual(emulatorRegistrationDirectories({ LOCALAPPDATA: 'C:/Users/a/AppData/Local' }), [
    path.join('C:/Users/a/AppData/Local', 'Temp', 'avd', 'running'),
  ]);
  assert.deepEqual(emulatorRegistrationDirectories({}), []);
});

test('a registration needs its console port, gRPC port, token, and AVD', () => {
  assert.deepEqual(parseEmulatorRegistration('pid_71085.ini', registrationText(REGISTRATION)), {
    pid: 71085,
    consolePort: 5554,
    grpcPort: 8554,
    token: TOKEN,
    avdName: 'dev_android36',
  });
  const { 'avd.name': _name, ...idOnly } = REGISTRATION;
  assert.equal(
    parseEmulatorRegistration('pid_1.ini', registrationText(idOnly))?.avdName,
    'dev_android36',
  );
  const { 'grpc.token': _token, ...noToken } = REGISTRATION;
  assert.equal(parseEmulatorRegistration('pid_1.ini', registrationText(noToken)), undefined);
  assert.equal(
    parseEmulatorRegistration('pid_1.ini', registrationText({ ...REGISTRATION, 'grpc.port': '0' })),
    undefined,
  );
  assert.equal(parseEmulatorRegistration('notes.ini', registrationText(REGISTRATION)), undefined);
});

test('a live registration whose console names the same AVD is the endpoint', async () => {
  livePids.add(71085);
  await writeRegistration(71085, REGISTRATION);
  await writeRegistration(4242, { ...REGISTRATION, 'port.serial': '5556', 'grpc.port': '8556' });
  livePids.add(4242);

  const endpoint = await resolveEmulatorGrpcEndpoint(EMULATOR);

  assert.ok(endpoint);
  assert.deepEqual(endpoint.toJSON(), { pid: 71085, port: 8554, avdName: 'dev_android36' });
  assert.equal(endpoint.authorization(), `Bearer ${TOKEN}`);
  assert.deepEqual(
    consoleCalls.map((call) => call.command),
    [['emu', 'avd', 'name']],
  );
  // The credential never reaches a log line, a JSON payload, or an inspected object.
  assert.ok(!JSON.stringify(endpoint).includes(TOKEN));
  assert.ok(!inspect(endpoint, { depth: 5, showHidden: true }).includes(TOKEN));
});

test('a cached endpoint is reused while its emulator lives and looked up again after', async () => {
  livePids.add(71085);
  await writeRegistration(71085, REGISTRATION);
  const first = await resolveEmulatorGrpcEndpoint(EMULATOR);
  assert.equal(await resolveEmulatorGrpcEndpoint(EMULATOR), first);
  assert.equal(consoleCalls.length, 1);

  livePids.delete(71085);
  assert.equal(await resolveEmulatorGrpcEndpoint(EMULATOR), undefined);
});

test('no endpoint when the console names another AVD or cannot answer', async () => {
  livePids.add(71085);
  await writeRegistration(71085, REGISTRATION);
  consoleAvdName = 'other_avd';
  assert.equal(await resolveEmulatorGrpcEndpoint(EMULATOR), undefined);
  consoleAvdName = undefined;
  assert.equal(await resolveEmulatorGrpcEndpoint(EMULATOR), undefined);
});

test('no endpoint for a stale file, a contested port, or a device that is not an emulator', async () => {
  await writeRegistration(71085, REGISTRATION);
  assert.equal(await resolveEmulatorGrpcEndpoint(EMULATOR), undefined, 'dead process');

  livePids.add(71085);
  livePids.add(4242);
  await writeRegistration(4242, REGISTRATION);
  assert.equal(await resolveEmulatorGrpcEndpoint(EMULATOR), undefined, 'two files claim 5554');

  assert.equal(
    await resolveEmulatorGrpcEndpoint({ ...EMULATOR, kind: 'device', id: 'R58M12345' }),
    undefined,
  );
  assert.equal(consoleCalls.length, 0);
});
