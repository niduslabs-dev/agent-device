/**
 * Android emulator input through the emulator's own gRPC control interface (ADR 0041).
 *
 * A local emulator accepts mouse and key events on its gRPC port, which reaches the guest's virtual
 * touchscreen and keyboard in about a millisecond, without the snapshot helper's UiAutomation round
 * trip. Each entry point answers `unavailable` whenever this route is provably unused for the
 * request: the device is not a local emulator, its endpoint is not registered or confirmed, the
 * point cannot be placed on the panel, or the emulator refused the first call before running it.
 * The caller then takes its existing helper or adb route. A failure after a call may have run is
 * thrown with `dispatched: 'unknown'` and never falls back, so no input is sent twice.
 */
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError, discloseDispatch } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { sleep } from '@agent-device/host-kit/retry';
import { requireAndroidAdbHost } from './adb-host.ts';
import { resolveScopedAndroidAdbBackgroundTransport } from './adb-provider-scope.ts';
import {
  readAndroidDisplayOrientation,
  type AndroidDisplayOrientation,
} from './snapshot-capture.ts';
import {
  type EmulatorGrpcEndpoint,
  forgetEmulatorGrpcEndpoint,
  resolveEmulatorGrpcEndpoint,
} from './emulator-grpc-endpoint.ts';
import {
  callEmulatorController,
  decodeEmulatorMainDisplaySize,
  dropEmulatorGrpcConnection,
  EMULATOR_PRIMARY_BUTTON,
  EmulatorGrpcCallError,
  type EmulatorDisplaySize,
  encodeEmulatorKeyPress,
  encodeEmulatorMouseEvent,
} from './emulator-grpc-wire.ts';
import type { AndroidLoweredTouchPlan } from './touch-plan-lowering.ts';

export type EmulatorGrpcInputOutcome = 'dispatched' | 'unavailable';

/** The operator switch: unset or any value but `0`/`false`/`no`/`off` leaves the route on. */
export const ANDROID_EMULATOR_GRPC_INPUT_ENV = 'AGENT_DEVICE_ANDROID_EMULATOR_GRPC';

const ANDROID_EMULATOR_GRPC_INPUT_PHASE = 'android_emulator_grpc_input';
const ANDROID_EMULATOR_GRPC_FALLBACK_PHASE = 'android_emulator_grpc_input_fallback';
export const ANDROID_EMULATOR_GRPC_BACKEND = 'android-emulator-grpc';

/**
 * Android key codes the emulator's W3C key names reproduce exactly (`KeyboardEvent.key` in
 * `emulator_controller.proto`). Any other key keeps the helper route.
 */
const EMULATOR_KEY_NAMES: Readonly<Record<number, string>> = {
  3: 'GoHome',
  4: 'GoBack',
  66: 'Enter',
  187: 'AppSwitch',
};

type PointerStep = Readonly<{ atMs: number; x: number; y: number; buttons: number }>;

type PointerRoute = Readonly<{
  endpoint: EmulatorGrpcEndpoint;
  toPanel: (x: number, y: number) => { x: number; y: number };
}>;

const panelSizes = new WeakMap<EmulatorGrpcEndpoint, EmulatorDisplaySize>();

export async function pressAndroidEmulatorKeyOverGrpc(
  device: DeviceInfo,
  keyCode: number,
  signal?: AbortSignal,
): Promise<EmulatorGrpcInputOutcome> {
  const key = EMULATOR_KEY_NAMES[keyCode];
  if (key === undefined) return 'unavailable';
  const endpoint = await resolveRouteEndpoint(device, signal);
  if (!endpoint) return 'unavailable';
  signal?.throwIfAborted();
  try {
    await callEmulatorController(endpoint, 'sendKey', encodeEmulatorKeyPress(key), signal);
  } catch (error) {
    return failedBeforeFirstStep(device, endpoint, error, 'key', signal);
  }
  emitDiagnostic({
    level: 'debug',
    phase: ANDROID_EMULATOR_GRPC_INPUT_PHASE,
    data: { kind: 'key', key, port: endpoint.port },
  });
  return 'dispatched';
}

export async function tapAndroidEmulatorOverGrpc(
  device: DeviceInfo,
  x: number,
  y: number,
  signal?: AbortSignal,
): Promise<EmulatorGrpcInputOutcome> {
  const route = await resolvePointerRoute(device, signal);
  if (!route) return 'unavailable';
  const point = route.toPanel(x, y);
  return await sendPointerSteps(
    device,
    route.endpoint,
    [
      { atMs: 0, ...point, buttons: EMULATOR_PRIMARY_BUTTON },
      { atMs: 0, ...point, buttons: 0 },
    ],
    'tap',
    signal,
  );
}

/**
 * Plays a one-finger plan (a swipe, a scroll, or a long press) with the samples' own pacing.
 * Undefined means the plan is not one this route plays, and the caller keeps its own route.
 */
export async function runAndroidEmulatorTouchPlanOverGrpc(
  device: DeviceInfo,
  plan: AndroidLoweredTouchPlan,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  if (plan.topology !== 'single') return undefined;
  const route = await resolvePointerRoute(device, signal);
  if (!route) return undefined;
  const steps = singlePointerSteps(plan, route.toPanel);
  const startedAt = Date.now();
  const outcome = await sendPointerSteps(device, route.endpoint, steps, plan.intent, signal);
  if (outcome === 'unavailable') return undefined;
  return {
    backend: ANDROID_EMULATOR_GRPC_BACKEND,
    injectedEvents: steps.length,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * The emulator's input lands in the panel's natural orientation, so a point read in the display's
 * current rotation is turned back before it is sent. The rotation and extent come from the capture
 * that produced the point; the extent, turned back, must be the whole panel. A folded or resized
 * display, or a display with no recorded rotation, has no placement here.
 */
export function placeOnEmulatorPanel(
  orientation: AndroidDisplayOrientation,
  panel: EmulatorDisplaySize,
): ((x: number, y: number) => { x: number; y: number }) | undefined {
  const quarterTurned = orientation.rotation % 2 === 1;
  const naturalWidth = quarterTurned ? orientation.height : orientation.width;
  const naturalHeight = quarterTurned ? orientation.width : orientation.height;
  if (naturalWidth !== panel.width || naturalHeight !== panel.height) return undefined;
  const maxX = panel.width - 1;
  const maxY = panel.height - 1;
  const clamp = (value: number, max: number) => Math.min(max, Math.max(0, Math.round(value)));
  switch (orientation.rotation) {
    case 0:
      return (x, y) => ({ x: clamp(x, maxX), y: clamp(y, maxY) });
    case 1:
      return (x, y) => ({ x: clamp(maxX - y, maxX), y: clamp(x, maxY) });
    case 2:
      return (x, y) => ({ x: clamp(maxX - x, maxX), y: clamp(maxY - y, maxY) });
    case 3:
      return (x, y) => ({ x: clamp(y, maxX), y: clamp(maxY - x, maxY) });
  }
}

function singlePointerSteps(
  plan: Extract<AndroidLoweredTouchPlan, { topology: 'single' }>,
  toPanel: PointerRoute['toPanel'],
): PointerStep[] {
  const samples = plan.pointers[0].samples;
  const steps: PointerStep[] = samples.map((sample) => ({
    atMs: sample.offsetMs,
    ...toPanel(sample.point.x, sample.point.y),
    buttons: EMULATOR_PRIMARY_BUTTON,
  }));
  const last = steps.at(-1)!;
  steps.push({ ...last, buttons: 0 });
  return steps;
}

async function sendPointerSteps(
  device: DeviceInfo,
  endpoint: EmulatorGrpcEndpoint,
  steps: readonly PointerStep[],
  kind: string,
  signal: AbortSignal | undefined,
): Promise<EmulatorGrpcInputOutcome> {
  signal?.throwIfAborted();
  const startedAt = Date.now();
  let sent = 0;
  try {
    for (const step of steps) {
      const waitMs = startedAt + step.atMs - Date.now();
      if (waitMs > 0) await sleep(waitMs, signal);
      signal?.throwIfAborted();
      await callEmulatorController(endpoint, 'sendMouse', encodeEmulatorMouseEvent(step), signal);
      sent += 1;
    }
  } catch (error) {
    if (sent === 0) return failedBeforeFirstStep(device, endpoint, error, kind, signal);
    await releaseAfterFailure(endpoint, steps[sent - 1]!);
    throw failedAfterSteps(error, kind, sent);
  }
  emitDiagnostic({
    level: 'debug',
    phase: ANDROID_EMULATOR_GRPC_INPUT_PHASE,
    data: { kind, events: sent, port: endpoint.port },
  });
  return 'dispatched';
}

/** A finger left down would hold the touchscreen until the next input; lift it where it was. */
async function releaseAfterFailure(
  endpoint: EmulatorGrpcEndpoint,
  last: PointerStep,
): Promise<void> {
  if (last.buttons === 0) return;
  try {
    await callEmulatorController(
      endpoint,
      'sendMouse',
      encodeEmulatorMouseEvent({ ...last, buttons: 0 }),
    );
  } catch {
    // The original failure is the one the caller must see.
  }
}

function failedBeforeFirstStep(
  device: DeviceInfo,
  endpoint: EmulatorGrpcEndpoint,
  error: unknown,
  kind: string,
  signal: AbortSignal | undefined,
): 'unavailable' {
  // Cancelled before the first send: nothing reached the device, and the cancellation is the outcome.
  if (signal?.aborted && !(error instanceof EmulatorGrpcCallError)) throw error;
  if (!(error instanceof EmulatorGrpcCallError) || error.reach !== 'not-sent') {
    throw failedAfterSteps(error, kind, 0);
  }
  // A refused or unreachable endpoint is stale (a restarted emulator, a new token): look again next
  // time, and let this request take the helper route.
  forgetEmulatorGrpcEndpoint(device.id);
  dropEmulatorGrpcConnection(endpoint.port);
  emitDiagnostic({
    level: 'warn',
    phase: ANDROID_EMULATOR_GRPC_FALLBACK_PHASE,
    data: { kind, port: endpoint.port, grpcStatus: error.grpcStatus },
  });
  return 'unavailable';
}

function failedAfterSteps(error: unknown, kind: string, sent: number): unknown {
  const failure = new AppError(
    'COMMAND_FAILED',
    `Android emulator ${kind} input over gRPC failed`,
    {
      reason: 'android_emulator_grpc_input_failed',
      ...(error instanceof EmulatorGrpcCallError && error.grpcStatus !== undefined
        ? { grpcStatus: error.grpcStatus }
        : {}),
    },
    error,
  );
  return discloseDispatch(failure, 'unknown', sent > 0 ? { dispatchedSteps: sent } : {});
}

async function resolvePointerRoute(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
): Promise<PointerRoute | undefined> {
  const orientation = readAndroidDisplayOrientation(device);
  if (!orientation) return undefined;
  const endpoint = await resolveRouteEndpoint(device, signal);
  if (!endpoint) return undefined;
  const panel = await readPanelSize(device, endpoint, signal);
  if (!panel) return undefined;
  const toPanel = placeOnEmulatorPanel(orientation, panel);
  return toPanel ? { endpoint, toPanel } : undefined;
}

async function resolveRouteEndpoint(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
): Promise<EmulatorGrpcEndpoint | undefined> {
  if (!isEmulatorGrpcInputEnabled()) return undefined;
  // A provider-scoped device is reached through the provider's own transport; a local registration
  // that shares its serial belongs to some other emulator.
  if (resolveScopedAndroidAdbBackgroundTransport(device).mode !== 'local') return undefined;
  return await resolveEmulatorGrpcEndpoint(device, signal);
}

/** The panel size never changes for a running emulator, so one read serves its lifetime. */
async function readPanelSize(
  device: DeviceInfo,
  endpoint: EmulatorGrpcEndpoint,
  signal: AbortSignal | undefined,
): Promise<EmulatorDisplaySize | undefined> {
  const cached = panelSizes.get(endpoint);
  if (cached) return cached;
  let reply: Buffer;
  try {
    reply = await callEmulatorController(
      endpoint,
      'getDisplayConfigurations',
      new Uint8Array(),
      signal,
    );
  } catch (error) {
    if (error instanceof EmulatorGrpcCallError && error.reach === 'not-sent') {
      forgetEmulatorGrpcEndpoint(device.id);
      dropEmulatorGrpcConnection(endpoint.port);
    }
    return undefined;
  }
  let panel: EmulatorDisplaySize | undefined;
  try {
    panel = decodeEmulatorMainDisplaySize(reply);
  } catch {
    return undefined;
  }
  if (panel) panelSizes.set(endpoint, panel);
  return panel;
}

function isEmulatorGrpcInputEnabled(): boolean {
  const value = requireAndroidAdbHost().environment[ANDROID_EMULATOR_GRPC_INPUT_ENV];
  return value === undefined || !/^(0|false|no|off)$/i.test(value);
}
