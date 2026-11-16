/**
 * Finds the gRPC endpoint of the local emulator behind an `emulator-<console port>` serial.
 *
 * Every emulator writes `pid_<pid>.ini` into a per-user registration directory at startup (the
 * file Android Studio's running-device catalog reads). The file names its console port
 * (`port.serial`), its gRPC port and bearer token, and its AVD. A serial maps to the one live file
 * whose console port matches; the emulator's own console then confirms the AVD name, so a serial
 * that a remote adb server answers for never reaches a local emulator that happens to share its
 * port.
 */
import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { isProcessAlive } from '@agent-device/host-kit/process';
import { requireAndroidAdbHost } from './adb-host.ts';
import { runEmulatorConsole } from './emulator-console.ts';
import type { EmulatorGrpcTarget } from './emulator-grpc-wire.ts';

const REGISTRATION_FILE = /^pid_(\d+)\.ini$/;
const EMULATOR_SERIAL = /^emulator-(\d+)$/;
const REGISTRATION_RELATIVE_DIRECTORY = path.join('avd', 'running');

/** One running emulator, as its registration file and console describe it. */
export class EmulatorGrpcEndpoint implements EmulatorGrpcTarget {
  readonly pid: number;
  readonly port: number;
  readonly avdName: string;
  readonly #token: string;

  constructor(fields: { pid: number; port: number; avdName: string; token: string }) {
    this.pid = fields.pid;
    this.port = fields.port;
    this.avdName = fields.avdName;
    this.#token = fields.token;
  }

  readonly authorization = (): string => `Bearer ${this.#token}`;

  /** Diagnostics and logs see where the endpoint is, never its credential. */
  toJSON(): Record<string, unknown> {
    return { pid: this.pid, port: this.port, avdName: this.avdName };
  }
}

type Registration = Readonly<{
  pid: number;
  consolePort: number;
  grpcPort: number;
  token: string;
  avdName: string;
}>;

/** The console port an `emulator-<port>` serial names, or undefined for any other serial. */
export function emulatorConsolePortFromSerial(serial: string): number | undefined {
  const match = EMULATOR_SERIAL.exec(serial);
  if (!match) return undefined;
  const port = Number(match[1]);
  return Number.isSafeInteger(port) && port > 0 ? port : undefined;
}

/**
 * Every directory the emulator registers in on some host, as Android Studio resolves them: the user
 * cache on macOS, `%LOCALAPPDATA%\Temp` on Windows, then `$XDG_RUNTIME_DIR` and `~/.android` on
 * Linux. Only the host's own one exists, so the caller reads them in order and skips the absent.
 */
export function emulatorRegistrationDirectories(
  environment: Record<string, string | undefined>,
): string[] {
  const containers = [
    environment.HOME && path.join(environment.HOME, 'Library', 'Caches', 'TemporaryItems'),
    environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, 'Temp'),
    environment.XDG_RUNTIME_DIR,
    environment.HOME && path.join(environment.HOME, '.android'),
  ];
  return containers
    .filter((container): container is string => Boolean(container))
    .map((container) => path.join(container, REGISTRATION_RELATIVE_DIRECTORY));
}

/** Reads one `pid_<pid>.ini`; undefined when a field the endpoint needs is missing or malformed. */
export function parseEmulatorRegistration(
  fileName: string,
  contents: string,
): Registration | undefined {
  const fileMatch = REGISTRATION_FILE.exec(fileName);
  if (!fileMatch) return undefined;
  const values = new Map<string, string>();
  for (const line of contents.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const pid = Number(fileMatch[1]);
  const consolePort = Number(values.get('port.serial'));
  const grpcPort = Number(values.get('grpc.port'));
  const token = values.get('grpc.token');
  const avdName = values.get('avd.name') || values.get('avd.id');
  if (!isPort(consolePort) || !isPort(grpcPort) || !token || !avdName) return undefined;
  return { pid, consolePort, grpcPort, token, avdName };
}

const endpoints = new Map<string, EmulatorGrpcEndpoint>();

/** Forgets the endpoint of `serial`, so the next lookup reads the registrations again. */
export function forgetEmulatorGrpcEndpoint(serial: string): void {
  endpoints.delete(serial);
}

/**
 * The gRPC endpoint of `device`, or undefined when it is not a local emulator with a registered,
 * live, identity-confirmed endpoint. A cached endpoint is kept only while its process lives.
 */
export async function resolveEmulatorGrpcEndpoint(
  device: DeviceInfo,
  signal?: AbortSignal,
): Promise<EmulatorGrpcEndpoint | undefined> {
  const consolePort =
    device.kind === 'emulator' ? emulatorConsolePortFromSerial(device.id) : undefined;
  if (consolePort === undefined) return undefined;
  const cached = endpoints.get(device.id);
  if (cached && isProcessAlive(cached.pid)) return cached;
  endpoints.delete(device.id);
  const registration = await findLiveRegistration(consolePort);
  if (!registration) return undefined;
  if ((await readConsoleAvdName(device, signal)) !== registration.avdName) return undefined;
  const endpoint = new EmulatorGrpcEndpoint({
    pid: registration.pid,
    port: registration.grpcPort,
    avdName: registration.avdName,
    token: registration.token,
  });
  endpoints.set(device.id, endpoint);
  return endpoint;
}

async function findLiveRegistration(consolePort: number): Promise<Registration | undefined> {
  const host = requireAndroidAdbHost();
  for (const directory of emulatorRegistrationDirectories(host.environment)) {
    const names = await host.files.readDirectory(directory).catch(() => undefined);
    if (!names) continue;
    const matches: Registration[] = [];
    for (const name of names) {
      const registration = await readRegistration(directory, name);
      if (registration?.consolePort === consolePort && isProcessAlive(registration.pid)) {
        matches.push(registration);
      }
    }
    // Two live processes cannot hold one console port; two files claiming it means one is a
    // reused PID with a stale file, and neither can be trusted.
    if (matches.length > 0) return matches.length === 1 ? matches[0] : undefined;
  }
  return undefined;
}

async function readRegistration(
  directory: string,
  name: string,
): Promise<Registration | undefined> {
  if (!REGISTRATION_FILE.test(name)) return undefined;
  const contents = await requireAndroidAdbHost()
    .files.readText(path.join(directory, name))
    .catch(() => undefined);
  return contents === undefined ? undefined : parseEmulatorRegistration(name, contents);
}

/** `adb emu avd name` answers the AVD name, then `OK`. A console that fails names nothing. */
async function readConsoleAvdName(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  try {
    const reply = await runEmulatorConsole(device, ['avd', 'name'], signal);
    if (reply.refusal !== undefined) return undefined;
    return reply.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && line !== 'OK');
  } catch {
    return undefined;
  }
}

function isPort(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 65_535;
}
