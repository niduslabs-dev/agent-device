import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  readFillTargetFromPositionals,
  readInteractionTargetFromPositionals,
} from './interaction-positionals.ts';

function assertInvalidArgs(fn: () => unknown, messageFragment: string) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { code?: unknown }).code, 'INVALID_ARGS');
    assert.ok(
      error.message.includes(messageFragment),
      `expected error message to include ${JSON.stringify(messageFragment)}, got ${JSON.stringify(error.message)}`,
    );
    return true;
  });
}

test('readInteractionTargetFromPositionals points a role word used as a key at role=/label=', () => {
  assertInvalidArgs(
    () => readInteractionTargetFromPositionals(['button="Push Article"']),
    'Unknown selector key "button". Supported:',
  );
  assertInvalidArgs(
    () => readInteractionTargetFromPositionals(['button="Push Article"']),
    'Did you mean role=button label="Push Article"?',
  );
});

test('readInteractionTargetFromPositionals folds unquoted multi-word values into the suggestion', () => {
  // An unquoted value splits across positionals; the hint must keep the full text, not just
  // the fragment attached to the key.
  assertInvalidArgs(
    () => readInteractionTargetFromPositionals(['button=Push', 'Article']),
    'Did you mean role=button label="Push Article"?',
  );
});

test('readInteractionTargetFromPositionals points an unknown non-role key at label=', () => {
  assertInvalidArgs(
    () => readInteractionTargetFromPositionals(['color="red"']),
    'Unknown selector key "color". Supported:',
  );
  assertInvalidArgs(
    () => readInteractionTargetFromPositionals(['color="red"']),
    'Did you mean label="red"?',
  );
  // Non-role keys never get the role= suggestion.
  assert.throws(
    () => readInteractionTargetFromPositionals(['color="red"']),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('role='));
      return true;
    },
  );
});

test('readInteractionTargetFromPositionals keeps existing behavior for a known key with a bad value', () => {
  assertInvalidArgs(
    () => readInteractionTargetFromPositionals(['visible=maybe']),
    'is not a @ref, selector, or "x y" point',
  );
});

test('readInteractionTargetFromPositionals still parses "x y" points', () => {
  assert.deepEqual(readInteractionTargetFromPositionals(['10', '20']), { x: 10, y: 20 });
});

test('readInteractionTargetFromPositionals still resolves @refs and valid selectors', () => {
  assert.deepEqual(readInteractionTargetFromPositionals(['@e5']), { ref: '@e5' });
  assert.deepEqual(readInteractionTargetFromPositionals(['text="Sign in"']), {
    selector: 'text="Sign in"',
  });
});

test('readFillTargetFromPositionals points a role word used as a key at role=/label= too', () => {
  assertInvalidArgs(
    () => readFillTargetFromPositionals(['button="Push Article"', 'hello']),
    'Did you mean role=button label="Push Article"?',
  );
  // Fill treats the first two positionals as the target; an unquoted split value folds back in.
  assertInvalidArgs(
    () => readFillTargetFromPositionals(['button=Push', 'Article', 'hello']),
    'Did you mean role=button label="Push Article"?',
  );
});

test('readFillTargetFromPositionals still parses "x y" points and selectors', () => {
  assert.deepEqual(readFillTargetFromPositionals(['10', '20', 'hi']), {
    kind: 'point',
    target: { x: 10, y: 20 },
    text: 'hi',
  });
  assert.deepEqual(readFillTargetFromPositionals(['id="field-email"', 'qa@example.com']), {
    kind: 'selector',
    target: { selector: 'id="field-email"' },
    text: 'qa@example.com',
  });
});

test('readFillTargetFromPositionals treats every token after a ref as text', () => {
  assert.deepEqual(readFillTargetFromPositionals(['@e29~s317228', 'good', 'morning']), {
    kind: 'ref',
    target: { ref: '@e29~s317228' },
    text: 'good morning',
  });
});

const GENERAL_TAP_CHAIN =
  'label="General" hittable=true || label="General" || value="General" hittable=true || value="General" || id="General" hittable=true || id="General"';

test('readInteractionTargetFromPositionals reads plain text as a label/value/id chain that prefers hittable', () => {
  assert.deepEqual(readInteractionTargetFromPositionals(['General'], { acceptPlainText: true }), {
    selector: GENERAL_TAP_CHAIN,
  });
  // Unquoted words join into one text, and a quote in the text stays inside the selector value.
  const quoted = String.raw`"Say \"hi\""`;
  assert.deepEqual(
    readInteractionTargetFromPositionals(['Say', '"hi"'], { acceptPlainText: true }),
    {
      selector: [
        `label=${quoted} hittable=true`,
        `label=${quoted}`,
        `value=${quoted} hittable=true`,
        `value=${quoted}`,
        `id=${quoted} hittable=true`,
        `id=${quoted}`,
      ].join(' || '),
    },
  );
});

test('readInteractionTargetFromPositionals keeps refs, selectors and refusals ahead of plain text', () => {
  const plain = { acceptPlainText: true };
  assert.deepEqual(readInteractionTargetFromPositionals(['@handle'], plain), { ref: '@handle' });
  assert.deepEqual(readInteractionTargetFromPositionals(['text="Sign in"'], plain), {
    selector: 'text="Sign in"',
  });
  assert.deepEqual(readInteractionTargetFromPositionals(['10', '20'], plain), { x: 10, y: 20 });
  assertInvalidArgs(
    () => readInteractionTargetFromPositionals(['e12'], plain),
    'Did you mean "@e12"?',
  );
  assertInvalidArgs(
    () => readInteractionTargetFromPositionals(['button="Push Article"'], plain),
    'Unknown selector key "button".',
  );
  assertInvalidArgs(
    () => readInteractionTargetFromPositionals(['visible=maybe'], plain),
    'is not a @ref, selector, or "x y" point',
  );
  // A lone number is half a point, not text.
  assertInvalidArgs(
    () => readInteractionTargetFromPositionals(['12'], plain),
    'is not a @ref, selector, or "x y" point',
  );
  // Callers that do not opt in (hover) keep the refusal.
  assertInvalidArgs(
    () => readInteractionTargetFromPositionals(['General']),
    'To match by visible text, use text="General"',
  );
});

test('readFillTargetFromPositionals reads a plain-text target as a chain that prefers editable', () => {
  const plain = { acceptPlainText: true };
  assert.deepEqual(readFillTargetFromPositionals(['Search', 'wallpaper', 'art'], plain), {
    kind: 'selector',
    target: {
      selector:
        'label="Search" editable=true || label="Search" || value="Search" editable=true || value="Search" || id="Search" editable=true || id="Search"',
    },
    text: 'wallpaper art',
  });
  // A forgotten text argument stays distinguishable from the clear request.
  assert.equal(readFillTargetFromPositionals(['Search'], plain).text, undefined);
  assert.equal(readFillTargetFromPositionals(['Search', ''], plain).text, '');
  // Without the opt-in (fill --text-stdin), a stray positional is never read as a target.
  assertInvalidArgs(
    () => readFillTargetFromPositionals(['Search']),
    'is not a @ref, selector, or "x y" point',
  );
});
