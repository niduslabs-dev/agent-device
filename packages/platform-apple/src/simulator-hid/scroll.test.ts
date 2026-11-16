import { expect, test } from 'vitest';
import { controlledScrollDragPath, readHostScrollDrag } from './scroll.ts';

const drag = {
  from: { x: 201, y: 700 },
  to: { x: 201, y: 248 },
  viewport: { width: 402, height: 874 },
};

test('the controlled drag runs from the planned start to the planned end on a frame cadence', () => {
  const path = controlledScrollDragPath(drag, 200);

  expect(path[0]).toEqual({ x: 201, y: 700, offsetMs: 0 });
  expect(path.find((sample) => sample.offsetMs === 200)).toEqual({ x: 201, y: 248, offsetMs: 200 });
  for (let i = 1; i < path.length - 1; i += 1) {
    expect(path[i]!.offsetMs - path[i - 1]!.offsetMs).toBeLessThanOrEqual(17);
  }
});

test('the finger slows to rest before it lifts, so the list stops where the finger stops', () => {
  const path = controlledScrollDragPath(drag, 200);
  const moving = path.filter((sample) => sample.offsetMs <= 200);
  const steps = moving.slice(1).map((sample, i) => Math.abs(sample.y - moving[i]!.y));

  for (let i = 1; i < steps.length; i += 1) expect(steps[i]!).toBeLessThanOrEqual(steps[i - 1]!);
  expect(steps.at(-1)!).toBeLessThan(steps[0]! / 50);
  // The finger then rests at the end for a few frames before it lifts.
  expect(path.at(-1)).toEqual({ x: 201, y: 248, offsetMs: 248 });
});

test('a runner that dragged itself answers no host drag', () => {
  expect(readHostScrollDrag({ message: 'scrolled', x: 1, y: 2 })).toBeUndefined();
});

test('a planned drag is read in the app points the runner answered', () => {
  expect(
    readHostScrollDrag({
      hostScrollDrag: { x: 201, y: 700, x2: 201, y2: 248, viewportWidth: 402, viewportHeight: 874 },
    }),
  ).toEqual(drag);
});

test('an unreadable planned drag fails as not dispatched instead of reporting a scroll', () => {
  expect(() => readHostScrollDrag({ hostScrollDrag: { x: 201, y: 700 } })).toThrow(
    expect.objectContaining({
      details: expect.objectContaining({
        reason: 'scroll_host_drag_unreadable',
        dispatched: 'no',
      }),
    }),
  );
});
