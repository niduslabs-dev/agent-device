import { stampSnapshotIdentity } from '@agent-device/contracts/snapshot-producers';
import {
  attachSnapshotClickabilityEvidence,
  attachSnapshotOcclusionContextEvidence,
  type AndroidSnapshotBackendMetadata,
  type SnapshotClickabilityEvidence,
  type SnapshotOcclusionContextEvidence,
} from '@agent-device/contracts/capture';
import type {
  RawSnapshotNode,
  SnapshotKeyboardBandFact,
  SnapshotQualityVerdict,
  SnapshotQualityNote,
  SnapshotViewportSize,
} from '@agent-device/kernel/snapshot';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { SnapshotBackend } from '@agent-device/contracts/snapshot-model';
import { snapshotViewportSizeFrom } from '@agent-device/kernel/rect';
import type { AndroidSnapshotHelperMetadata } from './snapshot-helper-types.ts';
import type { AndroidSnapshotAnalysis } from './ui-hierarchy.ts';

const androidCaptureEvidence = Symbol('androidSnapshotCaptureEvidence');

type AndroidCaptureEvidence = Readonly<{
  clickability: Extract<SnapshotClickabilityEvidence, { provider: 'android-helper' }>;
  occlusionContext?: SnapshotOcclusionContextEvidence;
}>;

type AndroidSnapshotCaptureData = Readonly<{
  nodes: RawSnapshotNode[];
  truncated?: boolean;
  analysis: AndroidSnapshotAnalysis;
  androidSnapshot: AndroidSnapshotBackendMetadata;
  quality?: SnapshotQualityVerdict;
  qualityNotes?: SnapshotQualityNote[];
  /** The input method window the helper captured, if any (see `androidSnapshotKeyboardFromTree`). */
  keyboard?: SnapshotKeyboardBandFact;
  /**
   * The screen the captured bounds are measured in (#3182): the helper's own display read, so a
   * capture of an empty screen still reports it. Derived, never stored, so this carrier cannot drift
   * from the `displayWidth`/`displayHeight` pair it came from.
   */
  viewport?: SnapshotViewportSize;
}>;

/** Opaque acquisition envelope: exact Android facts cannot be detached from the captured nodes. */
export type AndroidSnapshotCapture = AndroidSnapshotCaptureData & {
  readonly [androidCaptureEvidence]: AndroidCaptureEvidence;
};

export type AndroidSnapshotPublicationInput = AndroidSnapshotCaptureData & {
  backend: Extract<SnapshotBackend, 'android'>;
  producer: 'android-uiautomator';
};

export function createAndroidSnapshotCapture(
  data: AndroidSnapshotCaptureData,
  evidence: AndroidCaptureEvidence,
): AndroidSnapshotCapture {
  Object.defineProperty(data, androidCaptureEvidence, { value: evidence });
  return data as AndroidSnapshotCapture;
}

/**
 * The one place Android's published viewport is built: from the display pair the helper transport
 * carries (#3182), through the shared guard, so a zero the platform answered with never becomes a
 * viewport a reader trusts. The pair lives only on the helper's own metadata; the backend metadata
 * the response publishes keeps the converted fact instead of a second copy of the raw read.
 */
export function androidSnapshotViewportFromHelperMetadata(
  metadata: AndroidSnapshotHelperMetadata,
): SnapshotViewportSize | undefined {
  return snapshotViewportSizeFrom({
    x: 0,
    y: 0,
    width: metadata.displayWidth ?? Number.NaN,
    height: metadata.displayHeight ?? Number.NaN,
  });
}

/** The sole adapter from Android acquisition into daemon snapshot publication. */
export function androidSnapshotPublicationInput(
  capture: AndroidSnapshotCapture,
): AndroidSnapshotPublicationInput {
  const publication: AndroidSnapshotPublicationInput = stampSnapshotIdentity(capture, {
    backend: 'android',
    producer: 'android-uiautomator',
  });
  const evidence = capture[androidCaptureEvidence];
  attachSnapshotClickabilityEvidence(publication, evidence.clickability);
  if (evidence.occlusionContext) {
    attachSnapshotOcclusionContextEvidence(publication, evidence.occlusionContext);
  }
  return publication;
}

/**
 * The rotation and extent of a device's main display as its latest helper capture read them.
 *
 * Input that reaches the device below the window manager (the emulator's virtual touchscreen) is in
 * the panel's natural orientation, while every point agent-device holds was read in the display's
 * current rotation. This record is what places one in the other: it comes from the same capture the
 * points came from, so a ref and the rotation it is placed with always agree.
 */
export type AndroidDisplayOrientation = Readonly<{
  /** `Surface.ROTATION_*`: 0 natural, 1 a quarter turn, 2 a half turn, 3 three quarters. */
  rotation: 0 | 1 | 2 | 3;
  width: number;
  height: number;
}>;

const orientations = new Map<string, AndroidDisplayOrientation>();

/** Records what a capture read, or forgets the record when the capture could not say. */
export function noteAndroidDisplayOrientation(
  device: DeviceInfo,
  metadata: Pick<
    AndroidSnapshotHelperMetadata,
    'displayWidth' | 'displayHeight' | 'displayRotation'
  >,
): void {
  const { displayWidth: width, displayHeight: height, displayRotation: rotation } = metadata;
  if (
    (rotation === 0 || rotation === 1 || rotation === 2 || rotation === 3) &&
    width !== undefined &&
    height !== undefined &&
    width > 0 &&
    height > 0
  ) {
    orientations.set(device.id, { rotation, width, height });
    return;
  }
  orientations.delete(device.id);
}

/** Forgets the record of a device whose rotation is about to change. */
export function forgetAndroidDisplayOrientation(device: DeviceInfo): void {
  orientations.delete(device.id);
}

export function readAndroidDisplayOrientation(
  device: DeviceInfo,
): AndroidDisplayOrientation | undefined {
  return orientations.get(device.id);
}
