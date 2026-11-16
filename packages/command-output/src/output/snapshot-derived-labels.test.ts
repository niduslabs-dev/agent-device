import { test } from 'vitest';
import assert from 'node:assert/strict';
import { attachRefs, type RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { withNoColor } from '@agent-device/test-kit';
import { formatSnapshotText } from './snapshot.ts';

/** An iOS Settings search screen: a labeled cell, and suggestion buttons whose words sit on child text. */
function iosSettingsSearchNodes(): RawSnapshotNode[] {
  return [
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Settings',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      hittable: false,
    },
    {
      index: 1,
      parentIndex: 0,
      depth: 1,
      type: 'SearchField',
      label: 'Search',
      value: 'wall',
      rect: { x: 16, y: 120, width: 370, height: 36 },
      hittable: true,
    },
    {
      index: 2,
      parentIndex: 0,
      depth: 1,
      type: 'Button',
      rect: { x: 16, y: 170, width: 370, height: 44 },
      hittable: true,
    },
    {
      index: 3,
      parentIndex: 2,
      depth: 2,
      type: 'Other',
      rect: { x: 16, y: 170, width: 370, height: 44 },
      hittable: false,
    },
    {
      index: 4,
      parentIndex: 3,
      depth: 3,
      type: 'StaticText',
      label: ' ',
      rect: { x: 56, y: 180, width: 4, height: 22 },
      hittable: false,
    },
    {
      index: 5,
      parentIndex: 3,
      depth: 3,
      type: 'StaticText',
      label: '“wallpaper”',
      rect: { x: 56, y: 180, width: 120, height: 22 },
      hittable: false,
    },
    {
      index: 6,
      parentIndex: 0,
      depth: 1,
      type: 'Button',
      rect: { x: 16, y: 214, width: 370, height: 44 },
      hittable: true,
    },
    {
      index: 7,
      parentIndex: 6,
      depth: 2,
      type: 'StaticText',
      label: 'Wallpapers',
      rect: { x: 56, y: 224, width: 120, height: 22 },
      hittable: false,
    },
    {
      index: 8,
      parentIndex: 0,
      depth: 1,
      type: 'Cell',
      label: 'General',
      identifier: 'com.apple.settings.general',
      rect: { x: 16, y: 380.5, width: 370, height: 52 },
      hittable: true,
    },
    {
      index: 9,
      parentIndex: 8,
      depth: 2,
      type: 'StaticText',
      label: 'General',
      rect: { x: 60, y: 395.25, width: 80.04, height: 22 },
      hittable: false,
    },
    {
      index: 10,
      parentIndex: 0,
      depth: 1,
      type: 'Button',
      rect: { x: 16, y: 440, width: 370, height: 44 },
      hittable: true,
    },
  ];
}

function renderSettingsSearch(flatten: boolean): string {
  return withNoColor(() =>
    formatSnapshotText(
      { backend: 'xctest', nodes: attachRefs(iosSettingsSearchNodes()), truncated: false },
      { flatten },
    ),
  );
}

test('an unlabeled iOS button shows its first non-empty child text, marked apart from a label', () => {
  for (const flatten of [false, true]) {
    const text = renderSettingsSearch(flatten);
    assert.match(text, /@e3 \[button\] \[text:"“wallpaper”"\] \(16,170,370,44\)$/m);
    assert.match(text, /@e7 \[button\] \[text:"Wallpapers"\] \(16,214,370,44\)$/m);
  }
});

test('a labeled cell keeps its label, and a button without child text stays bare', () => {
  const text = renderSettingsSearch(true);
  assert.match(text, /^Snapshot: 11 nodes; frames \(x,y,w,h\) in points$/m);
  assert.match(text, /^@e9 \[cell\] "General" \(16,380\.5,370,52\)$/m);
  assert.match(text, /^@e10 \[text\] "General" \(60,395\.3,80,22\)$/m);
  assert.match(text, /^@e11 \[button\] \(16,440,370,44\)$/m);
});
