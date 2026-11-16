import { AppError } from '@agent-device/kernel/errors';

export function stripAtPrefix(ref: string | undefined): string | undefined {
  return ref?.startsWith('@') ? ref.slice(1) : ref;
}
import {
  detectUnknownSelectorKeyToken,
  isRoleHintWord,
  isSelectorToken,
  SELECTOR_KEY_NAMES,
  splitSelectorFromArgs,
} from '@agent-device/selectors';

type PositionalInteractionTarget =
  | { x: number; y: number }
  | { ref: string; label?: string }
  | { selector: string };

/**
 * `text` is `undefined` when the grammar supplied NO text argument at all, and `''` when it
 * supplied an empty one. `fill <target> ""` is the clear-field primitive (#2063), so the two
 * cannot collapse: without the distinction a forgotten argument (`fill @e57`) would silently
 * erase the field instead of being refused.
 */
export type DecodedFillTarget =
  | { kind: 'ref'; target: { ref: string }; text: string | undefined }
  | { kind: 'selector'; target: { selector: string }; text: string | undefined }
  | { kind: 'point'; target: { x: number; y: number }; text: string | undefined };

const BARE_SNAPSHOT_REF_PATTERN = /^e\d+$/;
/** A mistyped ref list such as `,@e1` is a ref mistake, not text to search for. */
const EMBEDDED_SNAPSHOT_REF_PATTERN = /@e\d+/;

/**
 * What the caller does with a plain-text target. It decides which matches the generated
 * selector tries first: a tap prefers a hittable match, a fill prefers an editable one.
 */
type PlainTextTargetUse = 'tap' | 'fill';

const PLAIN_TEXT_PREFERENCE_TERM: Record<PlainTextTargetUse, string> = {
  tap: 'hittable=true',
  fill: 'editable=true',
};

/** Fields a plain-text target matches, in priority order. */
const PLAIN_TEXT_FIELDS = ['label', 'value', 'id'] as const;

/**
 * Plain text such as `press General` or `fill Search wallpaper` is not a separate target kind.
 * It becomes an ordinary selector fallback chain: label, then value, then id, each tried first
 * with the use's preference term. The first alternative that matches anything decides, so a
 * preference only narrows within one field and never reaches past a better field. Several
 * matches that remain are refused by the acting pipeline like any other selector (ADR 0011).
 */
function plainTextTargetSelector(text: string, use: PlainTextTargetUse): string {
  const value = quoteSelectorValue(text);
  const preference = PLAIN_TEXT_PREFERENCE_TERM[use];
  return PLAIN_TEXT_FIELDS.flatMap((field) => [
    `${field}=${value} ${preference}`,
    `${field}=${value}`,
  ]).join(' || ');
}

/**
 * The text of positionals that are none of the other target shapes, or null. A ref (`@e3`,
 * and a literal `@handle`), a bare `e3`, a number (half of an `x y` point) and any `key=value`
 * token keep their own handling and refusals.
 */
function readPlainTextTarget(positionals: readonly string[]): string | null {
  const first = positionals[0];
  if (first === undefined || first.startsWith('@') || BARE_SNAPSHOT_REF_PATTERN.test(first)) {
    return null;
  }
  if (first.trim() !== '' && Number.isFinite(Number(first))) return null;
  if (positionals.some(isSelectorShapedToken)) return null;
  const text = positionals.join(' ').trim();
  return text === '' ? null : text;
}

function isSelectorShapedToken(token: string): boolean {
  if (token.trim() === '||' || EMBEDDED_SNAPSHOT_REF_PATTERN.test(token)) return true;
  if (!token.includes('=')) return false;
  return isSelectorToken(token) || detectUnknownSelectorKeyToken(token) !== null;
}

/**
 * The selector a `press`/`click`/`longpress` plain-text target stands for, or null when the
 * positionals are a selector expression or not plain text. The daemon calls this for raw
 * positionals that did not come through the CLI reader.
 */
export function readPlainTextTouchSelector(positionals: string[]): string | null {
  if (splitSelectorFromArgs(positionals)) return null;
  const text = readPlainTextTarget(positionals);
  return text === null ? null : plainTextTargetSelector(text, 'tap');
}

export function readInteractionTargetFromPositionals(
  positionals: string[],
  options: { acceptPlainText?: boolean } = {},
): PositionalInteractionTarget {
  if (positionals[0]?.startsWith('@')) {
    const label = optionalTrimmedText(positionals.slice(1));
    return { ref: positionals[0], ...(label === undefined ? {} : { label }) };
  }
  if (BARE_SNAPSHOT_REF_PATTERN.test(positionals[0] ?? '')) {
    throw new AppError(
      'INVALID_ARGS',
      `Did you mean "@${positionals[0]}"? Snapshot refs need the @ prefix.`,
    );
  }
  const selectorArgs = splitSelectorFromArgs(positionals);
  if (selectorArgs) {
    if (selectorArgs.rest.length > 0) {
      throw new AppError(
        'INVALID_ARGS',
        formatSelectorTrailingArgsFailure(positionals, selectorArgs),
      );
    }
    return { selector: selectorArgs.selectorExpression };
  }
  if (options.acceptPlainText) {
    const plainText = readPlainTextTarget(positionals);
    if (plainText !== null) return { selector: plainTextTargetSelector(plainText, 'tap') };
  }
  return readPointTarget(positionals);
}

/**
 * `acceptPlainText` reads a first positional that is no other target shape as a text match.
 * `fill --text-stdin` leaves it off: a stray positional there may be the secret itself, and a
 * text target would carry it into the selector and its errors.
 */
export function readFillTargetFromPositionals(
  positionals: string[],
  options: { acceptPlainText?: boolean } = {},
): DecodedFillTarget {
  const firstPositional = positionals[0];
  if (firstPositional?.startsWith('@')) {
    const textPositionals = positionals.slice(1);
    const text = textPositionals.length === 0 ? undefined : textPositionals.join(' ');
    return {
      kind: 'ref',
      target: { ref: firstPositional },
      text,
    };
  }
  if (BARE_SNAPSHOT_REF_PATTERN.test(firstPositional ?? '')) {
    throw new AppError(
      'INVALID_ARGS',
      `Did you mean "@${firstPositional}"? Snapshot refs need the @ prefix.`,
    );
  }
  const selectorArgs = splitSelectorFromArgs(positionals, { preferTrailingValue: true });
  if (selectorArgs) {
    return {
      kind: 'selector',
      target: { selector: selectorArgs.selectorExpression },
      text: selectorArgs.rest.length === 0 ? undefined : selectorArgs.rest.join(' '),
    };
  }
  const plainText = options.acceptPlainText ? readPlainTextTarget(positionals.slice(0, 1)) : null;
  if (plainText !== null) {
    const textPositionals = positionals.slice(1);
    return {
      kind: 'selector',
      target: { selector: plainTextTargetSelector(plainText, 'fill') },
      text: textPositionals.length === 0 ? undefined : textPositionals.join(' '),
    };
  }
  const pointText = positionals.slice(2);
  return {
    kind: 'point',
    target: readPointTarget(positionals.slice(0, 2)),
    text: pointText.length === 0 ? undefined : pointText.join(' '),
  };
}

function readPointTarget(positionals: string[]): { x: number; y: number } {
  const firstPositional = positionals[0] ?? '';
  const unknownKey = detectUnknownSelectorKeyToken(firstPositional);
  if (unknownKey) {
    // An unquoted multi-word value arrives split across positionals (button=Push Article), so
    // fold the trailing tokens back into the suggested value like mergeRestIntoSelectorValue.
    // A fully quoted value (button="Push Article") is complete; trailing tokens are not part of it.
    const value = hasCompleteQuotedValue(firstPositional)
      ? unknownKey.value
      : [unknownKey.value, ...positionals.slice(1)].join(' ').trim();
    throw new AppError(
      'INVALID_ARGS',
      formatUnknownSelectorKeyFailure({ key: unknownKey.key, value }),
    );
  }
  const x = Number(positionals[0]);
  const y = Number(positionals[1]);
  if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  throw new AppError('INVALID_ARGS', formatTargetParseFailure(positionals));
}

function hasCompleteQuotedValue(token: string): boolean {
  const valueRaw = token.slice(token.indexOf('=') + 1).trim();
  if (valueRaw.length < 2) return false;
  const first = valueRaw[0];
  return (first === '"' || first === "'") && valueRaw.endsWith(first);
}

function formatUnknownSelectorKeyFailure(unknownKey: { key: string; value: string }): string {
  const { key, value } = unknownKey;
  const supported = SELECTOR_KEY_NAMES.join(', ');
  const hint = isRoleHintWord(key)
    ? `Did you mean role=${key} label=${quoteSelectorValue(value)}?`
    : `Did you mean label=${quoteSelectorValue(value)}?`;
  return `Unknown selector key "${key}". Supported: ${supported}. ${hint}`;
}

function formatTargetParseFailure(positionals: string[]): string {
  const raw = positionals.filter((part) => part !== undefined).join(' ');
  if (!raw.trim()) {
    return 'Missing target. Pass an @ref from snapshot, a selector like text="Sign in", or "x y" coordinates.';
  }
  const base = `Target "${raw}" is not a @ref, selector, or "x y" point.`;
  if (positionals.some((part) => isSelectorToken(part ?? ''))) {
    return `${base} Selector values with spaces need quotes, e.g. text="Sign in".`;
  }
  return `${base} To match by visible text, use text=${quoteSelectorValue(raw)} (or label=/id=/role=), or pass an @ref from snapshot.`;
}

function formatSelectorTrailingArgsFailure(
  positionals: string[],
  selectorArgs: { selectorExpression: string; rest: string[] },
): string {
  const base = `Selector ${selectorArgs.selectorExpression} is followed by unexpected extra arguments: "${selectorArgs.rest.join(' ')}".`;
  const suggestion = mergeRestIntoSelectorValue(positionals, selectorArgs) ?? 'text="Sign in"';
  return `${base} Selector values with spaces need quotes, e.g. ${suggestion}.`;
}

function mergeRestIntoSelectorValue(
  positionals: string[],
  selectorArgs: { selectorExpression: string; rest: string[] },
): string | undefined {
  const boundary = positionals.length - selectorArgs.rest.length;
  const lastSelectorToken = positionals[boundary - 1];
  if (lastSelectorToken === undefined) return undefined;
  const equalsIdx = lastSelectorToken.indexOf('=');
  if (equalsIdx <= 0) return undefined;
  const mergedValue = [lastSelectorToken.slice(equalsIdx + 1), ...selectorArgs.rest].join(' ');
  const mergedToken = `${lastSelectorToken.slice(0, equalsIdx + 1)}${quoteSelectorValue(mergedValue)}`;
  return [...positionals.slice(0, boundary - 1), mergedToken].join(' ');
}

function quoteSelectorValue(value: string): string {
  return `"${value.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`;
}

function optionalTrimmedText(parts: string[]): string | undefined {
  const text = parts.join(' ').trim();
  return text ? text : undefined;
}
