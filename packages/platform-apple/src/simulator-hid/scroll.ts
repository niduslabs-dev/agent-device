import { sampleGestureOffsets } from '@agent-device/contracts/gesture-plan';
import { AppError } from '@agent-device/kernel/errors';
import type { SimulatorHidDragTarget } from './client.ts';

/**
 * The drag of a controlled iOS Simulator `scroll` that names no duration when the host sends it
 * through the digitizer. The runner's XCTest drag keeps `DEFAULT_IOS_SCROLL_DURATION_MS`: XCTest
 * adds its own playback confirmation, and its synthesized path is not this one.
 */
export const IOS_HOST_SCROLL_DURATION_MS = 300;

/** The drag a `scroll` with `scrollDispatch: host` planned, in the app's points. */
export type HostScrollDrag = Readonly<{
  from: Readonly<{ x: number; y: number }>;
  to: Readonly<{ x: number; y: number }>;
  viewport: SimulatorHidDragTarget['viewport'];
}>;

/**
 * The drag the runner planned and left to the host, or undefined when the runner dragged itself.
 * A plan that cannot be read leaves a scroll that moved nothing, so it fails with nothing sent.
 */
export function readHostScrollDrag(
  result: Readonly<Record<string, unknown>>,
): HostScrollDrag | undefined {
  const drag = result.hostScrollDrag;
  if (drag === undefined) return undefined;
  const { x, y, x2, y2, viewportWidth, viewportHeight } =
    drag !== null && typeof drag === 'object' ? (drag as Record<string, unknown>) : {};
  const values = [x, y, x2, y2, viewportWidth, viewportHeight];
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    throw new AppError('COMMAND_FAILED', 'scroll planned its drag but got no readable path.', {
      reason: 'scroll_host_drag_unreadable',
      dispatched: 'no',
      hint: 'Retry the scroll.',
    });
  }
  return {
    from: { x: x as number, y: y as number },
    to: { x: x2 as number, y: y2 as number },
    viewport: { width: viewportWidth as number, height: viewportHeight as number },
  };
}

/**
 * How long the finger rests at the end of a controlled drag before it lifts. UIKit takes the lift's
 * velocity from the last touches, and a digitizer move can arrive late and bunched with the one
 * after it, which reads as a flick. A rest of a few frames leaves a velocity of zero at the lift.
 */
const IOS_HOST_SCROLL_RELEASE_REST_MS = 48;

/**
 * The finger's path for a controlled scroll: a sample every frame, eased out with the cubic the
 * runner's controlled drag uses, then a rest of {@link IOS_HOST_SCROLL_RELEASE_REST_MS} at the end,
 * so the content stops where the finger stops instead of flinging on.
 */
export function controlledScrollDragPath(
  drag: HostScrollDrag,
  durationMs: number,
): SimulatorHidDragTarget['path'] {
  const moving = sampleGestureOffsets(durationMs, 'default').map((offsetMs) => {
    const progress = 1 - (1 - offsetMs / durationMs) ** 3;
    return {
      x: drag.from.x + (drag.to.x - drag.from.x) * progress,
      y: drag.from.y + (drag.to.y - drag.from.y) * progress,
      offsetMs,
    };
  });
  return [...moving, { ...drag.to, offsetMs: durationMs + IOS_HOST_SCROLL_RELEASE_REST_MS }];
}
