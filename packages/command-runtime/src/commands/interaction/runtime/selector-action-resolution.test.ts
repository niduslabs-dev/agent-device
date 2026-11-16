import assert from 'node:assert/strict';
import { test } from 'vitest';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';
import {
  ELEMENT14_DISTINCT_SUBTREE_NODES,
  EQUIVALENT_WRAPPER_CHAIN_NODES,
  UNVERIFIED_HITTABILITY_WRAPPER_CHAIN_NODES,
} from '@agent-device/test-kit';
import { SELECTOR_PIPELINE_POLICIES } from '@agent-device/selectors/selector-pipeline-policy';
import {
  readFillTargetFromPositionals,
  readInteractionTargetFromPositionals,
} from '@agent-device/selectors/interaction-positionals';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { resolveActionSelector } from './selector-action-resolution.ts';

test('mutating selector collapses a wrapper chain whose hittability is unverified', () => {
  const snapshot = makeSnapshotState(UNVERIFIED_HITTABILITY_WRAPPER_CHAIN_NODES);

  const result = resolveActionSelector(
    snapshot.nodes,
    'id="scoring_home_button"',
    'ios',
    SELECTOR_PIPELINE_POLICIES.promotedTarget,
  );

  assert.equal(result?.node.index, 1);
  assert.equal(result?.matches, 2);
  assert.equal(result?.disambiguation?.tiebreak, 'structural-equivalence');
});

test('mutating selector collapses a wrapper chain that resolves to one actionable node', () => {
  const snapshot = makeSnapshotState(EQUIVALENT_WRAPPER_CHAIN_NODES);

  const result = resolveActionSelector(
    snapshot.nodes,
    'label="Chat"',
    'ios',
    SELECTOR_PIPELINE_POLICIES.promotedTarget,
  );

  assert.equal(result?.node.index, 1);
  assert.equal(result?.matches, 3);
  assert.equal(result?.disambiguation?.tiebreak, 'structural-equivalence');
});

test('mutating selector rejects element-14-shaped matches in distinct subtrees with candidates', () => {
  const snapshot = makeSnapshotState(ELEMENT14_DISTINCT_SUBTREE_NODES);

  assert.throws(
    () =>
      resolveActionSelector(
        snapshot.nodes,
        'label="Team Standup"',
        'ios',
        SELECTOR_PIPELINE_POLICIES.promotedTarget,
      ),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'AMBIGUOUS_MATCH');
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.matches, 4);
      // The refusal comes before any tap, so a retry with a narrower selector is safe.
      assert.equal(details?.dispatched, 'no');
      assert.deepEqual(details?.candidates, [
        '@e2 [text] "Team Standup"',
        '@e3 [text-field] "Team Standup"',
        '@e4 [cell] "Team Standup"',
        '@e5 [button] "Team Standup"',
      ]);
      return true;
    },
  );
});

const ROOT: RawSnapshotNode = {
  index: 0,
  depth: 0,
  type: 'XCUIElementTypeApplication',
  rect: { x: 0, y: 0, width: 390, height: 844 },
  hittable: true,
};

function settingsRow(index: number, label: string, y: number, hittable: boolean): RawSnapshotNode {
  return {
    index,
    depth: 1,
    parentIndex: 0,
    type: 'XCUIElementTypeCell',
    label,
    rect: { x: 0, y, width: 390, height: 44 },
    hittable,
  };
}

function textField(index: number, label: string, y: number, type: string): RawSnapshotNode {
  return {
    index,
    depth: 1,
    parentIndex: 0,
    type,
    label,
    rect: { x: 16, y, width: 358, height: 36 },
    hittable: true,
  };
}

function tapSelector(text: string): string {
  const target = readInteractionTargetFromPositionals([text], { acceptPlainText: true });
  assert.ok('selector' in target);
  return target.selector;
}

function fillSelector(text: string): string {
  const decoded = readFillTargetFromPositionals([text, 'wallpaper'], { acceptPlainText: true });
  assert.equal(decoded.kind, 'selector');
  return decoded.kind === 'selector' ? decoded.target.selector : '';
}

function assertAmbiguous(run: () => unknown, selector: string, candidates: string[]): void {
  assert.throws(run, (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, 'AMBIGUOUS_MATCH');
    const details = (error as { details?: Record<string, unknown> }).details;
    assert.equal(details?.selector, selector);
    assert.equal(details?.dispatched, 'no');
    assert.deepEqual(details?.candidates, candidates);
    return true;
  });
}

test('plain-text press resolves the one element whose label matches, ignoring case', () => {
  const snapshot = makeSnapshotState([
    ROOT,
    settingsRow(1, 'Privacy', 100, true),
    settingsRow(2, 'General', 150, true),
  ]);

  const result = resolveActionSelector(
    snapshot.nodes,
    tapSelector('general'),
    'ios',
    SELECTOR_PIPELINE_POLICIES.promotedTarget,
  );

  assert.equal(result?.node.index, 2);
  assert.equal(result?.selector, 'label="general" hittable=true');
});

test('plain-text press refuses two hittable matches and lists both candidates', () => {
  const snapshot = makeSnapshotState([
    ROOT,
    settingsRow(1, 'General', 100, true),
    settingsRow(2, 'General', 300, true),
  ]);

  assertAmbiguous(
    () =>
      resolveActionSelector(
        snapshot.nodes,
        tapSelector('General'),
        'ios',
        SELECTOR_PIPELINE_POLICIES.promotedTarget,
      ),
    'label="General" hittable=true',
    ['@e2 [cell] "General"', '@e3 [cell] "General"'],
  );
});

test('plain-text press prefers the hittable match, while the explicit selector stays ambiguous', () => {
  const snapshot = makeSnapshotState([
    ROOT,
    settingsRow(1, 'General', 100, false),
    settingsRow(2, 'General', 300, true),
  ]);

  const result = resolveActionSelector(
    snapshot.nodes,
    tapSelector('General'),
    'ios',
    SELECTOR_PIPELINE_POLICIES.promotedTarget,
  );
  assert.equal(result?.node.index, 2);

  assertAmbiguous(
    () =>
      resolveActionSelector(
        snapshot.nodes,
        'label="General"',
        'ios',
        SELECTOR_PIPELINE_POLICIES.promotedTarget,
      ),
    'label="General"',
    ['@e2 [cell] "General"', '@e3 [cell] "General"'],
  );
});

test('plain-text fill prefers the editable field over a row with the same label', () => {
  const snapshot = makeSnapshotState([
    ROOT,
    settingsRow(1, 'Search', 100, true),
    textField(2, 'Search', 60, 'XCUIElementTypeSearchField'),
  ]);

  const result = resolveActionSelector(
    snapshot.nodes,
    fillSelector('Search'),
    'ios',
    SELECTOR_PIPELINE_POLICIES.resolvedTarget,
  );
  assert.equal(result?.node.index, 2);
  assert.equal(result?.selector, 'label="Search" editable=true');

  // An explicit selector keeps ADR 0011's refusal; nothing narrows it behind the author's back.
  assertAmbiguous(
    () =>
      resolveActionSelector(
        snapshot.nodes,
        'label="Search"',
        'ios',
        SELECTOR_PIPELINE_POLICIES.resolvedTarget,
      ),
    'label="Search"',
    ['@e2 [cell] "Search"', '@e3 [search] "Search"'],
  );
});

test('plain-text fill refuses two editable fields with the same label', () => {
  const snapshot = makeSnapshotState([
    ROOT,
    settingsRow(1, 'Name', 40, true),
    textField(2, 'Name', 100, 'XCUIElementTypeTextField'),
    textField(3, 'Name', 200, 'XCUIElementTypeTextField'),
  ]);

  assertAmbiguous(
    () =>
      resolveActionSelector(
        snapshot.nodes,
        fillSelector('Name'),
        'ios',
        SELECTOR_PIPELINE_POLICIES.resolvedTarget,
      ),
    'label="Name" editable=true',
    ['@e3 [text-field] "Name"', '@e4 [text-field] "Name"'],
  );
});
