import { test } from 'vitest';
import assert from 'node:assert/strict';
import { iosInteractiveKeyboardCaptureNodes } from '@agent-device/capture-kit/snapshot-chrome-fixtures';
import { attachRefs, type RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { withNoColor } from '@agent-device/test-kit';
import { formatSnapshotText } from './snapshot.ts';

const IOS_KEYBOARD_LINE =
  '@e41 [keyboard] keys: q w e r t y u i o p a s d f g h j k l shift z x c v b n m delete numbers Emoji space return (0,590,402,226)';

function renderIosKeyboardCapture(flatten: boolean): string {
  return withNoColor(() =>
    formatSnapshotText(
      {
        backend: 'xctest',
        nodes: attachRefs(iosInteractiveKeyboardCaptureNodes()),
        truncated: false,
      },
      { flatten },
    ),
  );
}

test('a real iOS keyboard capture collapses its keys into one keyboard line', () => {
  const text = renderIosKeyboardCapture(true);
  assert.match(text, /^Snapshot: \d+ .*; frames \(x,y,w,h\) in points$/m);
  assert.ok(text.split('\n').includes(IOS_KEYBOARD_LINE), text);
  assert.doesNotMatch(text, /\[key\]/);
  assert.doesNotMatch(text, /Padding-(Left|Right)/);
  assert.doesNotMatch(text, /UIKeyboardLayoutStar Preview/);
  // Keyboard surfaces outside the Keyboard container keep their own lines.
  assert.match(text, /^@e40 \[button\] "kind" \(268,546,134,44\)$/m);
  assert.match(text, /^@e81 \[button\] "Next keyboard" \(8,806,68,68\)$/m);
  assert.match(text, /^@e11 \[text-field\] "kit" \[editable\] \(35,319,333,51\)$/m);
});

test('the structured iOS keyboard line keeps the keyboard depth', () => {
  const text = renderIosKeyboardCapture(false);
  assert.ok(text.split('\n').includes(`  ${IOS_KEYBOARD_LINE}`), text);
  assert.doesNotMatch(text, /\[key\]/);
});

const LATIN_IME = 'com.google.android.inputmethod.latin';

function androidImeNodes(): RawSnapshotNode[] {
  const key = (index: number, label: string | undefined, x: number): RawSnapshotNode => ({
    index,
    depth: 2,
    parentIndex: 3,
    type: 'android.inputmethodservice.Keyboard$Key',
    ...(label === undefined ? {} : { label }),
    bundleId: LATIN_IME,
    rect: { x, y: 1700, width: 108, height: 160 },
    hittable: true,
  });
  return [
    {
      index: 0,
      depth: 0,
      type: 'android.widget.FrameLayout',
      bundleId: 'com.example.app',
      rect: { x: 0, y: 0, width: 1080, height: 2400 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'android.widget.EditText',
      label: 'Search',
      bundleId: 'com.example.app',
      rect: { x: 40, y: 200, width: 1000, height: 140 },
      hittable: true,
    },
    {
      index: 2,
      depth: 1,
      parentIndex: 0,
      type: 'android.widget.Button',
      label: 'Go',
      bundleId: 'com.example.app',
      rect: { x: 40, y: 360, width: 300, height: 120 },
      hittable: true,
    },
    // Android parent chains can cross windows: the IME run starts at the first IME-owned node.
    {
      index: 3,
      depth: 1,
      parentIndex: 0,
      type: 'android.inputmethodservice.SoftInputWindow',
      bundleId: LATIN_IME,
      rect: { x: 0, y: 1600, width: 1080, height: 800 },
    },
    key(4, 'q', 0),
    key(5, undefined, 108),
    key(6, 'w', 216),
    key(7, 'Space bar', 324),
  ];
}

test('an Android input method window collapses into one keyboard line in px', () => {
  const text = withNoColor(() =>
    formatSnapshotText(
      { backend: 'android', nodes: attachRefs(androidImeNodes()), truncated: false },
      { flatten: true },
    ),
  );
  assert.match(text, /^Snapshot: \d+ .*; frames \(x,y,w,h\) in px$/m);
  assert.match(text, /^@e4 \[keyboard\] keys: q w "Space bar" \(0,1600,1080,800\)$/m);
  assert.doesNotMatch(text, /@e[5-8] /);
});
