import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SnapshotState } from '@agent-device/contracts/snapshot-model';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import { surfaceScopedNodes } from '@agent-device/capture-kit/snapshot-baseline';
import { createFakeClock, createSettleDevice } from './__tests__/settle-device-fixtures.ts';
import { settleObservationCommand } from './settle.ts';

const TIMEOUT_MS = 10_000;

/** An Android-like search results screen: toolbar, field, and `rows` labeled result rows. */
function searchResults(rows: number): SnapshotState {
  const chrome = ['Back', 'wallp', 'Clear text'].map((label, index) => ({
    index,
    depth: 1,
    type: index === 1 ? 'android.widget.EditText' : 'android.widget.Button',
    label,
    rect: { x: index * 300, y: 132, width: 280, height: 189 },
    hittable: true,
  }));
  const results = Array.from({ length: rows }, (_, row) => ({
    index: chrome.length + row,
    depth: 1,
    type: 'android.widget.TextView',
    label: `Result ${row}`,
    rect: { x: 0, y: 430 + row * 190, width: 1080, height: 187 },
    hittable: true,
  }));
  return makeSnapshotState([...chrome, ...results]);
}

async function settleRedraw(params: {
  baseline: SnapshotState;
  captures: (elapsedMs: number) => SnapshotState;
  redrawsInPlace?: boolean;
}) {
  const clock = createFakeClock();
  const device = createSettleDevice({
    stored: params.baseline,
    clock,
    captureSnapshot: () => ({ snapshot: params.captures(clock.now()) }),
  });
  return await settleObservationCommand(device, {
    session: 'default',
    baseline: surfaceScopedNodes(params.baseline),
    timeoutMs: TIMEOUT_MS,
    ...(params.redrawsInPlace === false ? {} : { redrawsInPlace: true }),
  });
}

const FULL = searchResults(8);
const BLANK = searchResults(0);
const FILLS_AT_MS = 4_000;

test('a redraw in place keeps polling through a quiet blank tree until the list fills', async () => {
  const settle = await settleRedraw({
    baseline: FULL,
    captures: (elapsedMs) => (elapsedMs < FILLS_AT_MS ? BLANK : FULL),
  });

  assert.equal(settle.settled, true);
  assert.ok(settle.waitedMs >= FILLS_AT_MS, `settled after ${settle.waitedMs}ms`);
  assert.equal(settle.reason, undefined);
});

test('plain --settle still accepts the quiet blank tree', async () => {
  const settle = await settleRedraw({
    baseline: FULL,
    captures: (elapsedMs) => (elapsedMs < FILLS_AT_MS ? BLANK : FULL),
    redrawsInPlace: false,
  });

  assert.equal(settle.settled, true);
  assert.ok(settle.waitedMs < FILLS_AT_MS, `settled after ${settle.waitedMs}ms`);
});

test('a redraw in place settles on a smaller screen that keeps half the baseline', async () => {
  // 11 meaningful nodes before, 6 after (3 toolbar + 3 rows): at or above half settles at once.
  const settle = await settleRedraw({ baseline: FULL, captures: () => searchResults(3) });

  assert.equal(settle.settled, true);
  assert.ok(settle.waitedMs < FILLS_AT_MS, `settled after ${settle.waitedMs}ms`);
  assert.equal(settle.reason, undefined);
});

test('a redraw in place that never recovers ends unsettled with a typed reason', async () => {
  const settle = await settleRedraw({ baseline: FULL, captures: () => BLANK });

  assert.equal(settle.settled, false);
  assert.equal(settle.reason, 'tree-sparser-than-baseline');
  assert.ok(settle.waitedMs >= TIMEOUT_MS - 300, `gave up after ${settle.waitedMs}ms`);
  assert.equal(settle.diff, undefined);
  assert.match(settle.hint ?? '', /still be redrawing/);
});
