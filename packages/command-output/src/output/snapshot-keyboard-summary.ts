import { isAndroidInputMethodNode } from '@agent-device/contracts/android-input-ownership';
import { normalizeType } from '@agent-device/contracts/snapshot';
import { formatSnapshotFrameSuffix } from '@agent-device/capture-kit/snapshot-lines';
import { isPositiveFiniteRect } from '@agent-device/kernel/rect';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';

type KeyboardSummaryLine = {
  node: SnapshotNode;
  depth: number;
  type: string;
  text: string;
};

/**
 * Collapses each software keyboard to one text line, `[keyboard] keys: q w e … return (x,y,w,h)`.
 * A keyboard is an iOS `Keyboard` container with its subtree, or an Android input method run (the
 * topmost IME-owned node and the IME-owned nodes under it). The membership is structural, never
 * label-based, because key labels follow the input language.
 *
 * Text only: the snapshot state keeps every key node and ref, so a selector such as
 * `press 'label="q"'` still resolves a key. Keys without a label or value, and keys whose frame has
 * no area (iOS padding keys), are left out of the list.
 *
 * `treeNodes` is the whole tree the lines were drawn from; ancestry is read there because a
 * presentation can hide the keyboard container while it still shows its keys.
 */
export function collapseKeyboardLines<Line extends KeyboardSummaryLine>(
  lines: readonly Line[],
  treeNodes: readonly SnapshotNode[],
  options: { frames: boolean },
): Line[] {
  const rootByIndex = keyboardRootByNodeIndex(treeNodes);
  if (rootByIndex.size === 0) return [...lines];
  const keyLabelsByRoot = keyboardKeyLabels(treeNodes, rootByIndex);
  const emittedRoots = new Set<number>();
  const output: Line[] = [];
  for (const line of lines) {
    const root = rootByIndex.get(line.node.index);
    if (!root) {
      output.push(line);
      continue;
    }
    if (emittedRoots.has(root.index)) continue;
    emittedRoots.add(root.index);
    const keys = keyLabelsByRoot.get(root.index) ?? [];
    output.push({
      ...line,
      node: root,
      type: KEYBOARD_LINE_TYPE,
      text: formatKeyboardSummaryLine(root, line.depth, keys, options),
    });
  }
  return output;
}

const KEYBOARD_LINE_TYPE = 'keyboard';

function formatKeyboardSummaryLine(
  root: SnapshotNode,
  depth: number,
  keys: readonly string[],
  options: { frames: boolean },
): string {
  const indent = '  '.repeat(depth);
  const ref = root.ref ? `@${root.ref} ` : '';
  const keysText = keys.length > 0 ? ` keys: ${keys.join(' ')}` : '';
  const frameText = options.frames && root.rect ? formatSnapshotFrameSuffix(root.rect) : '';
  return `${indent}${ref}[${KEYBOARD_LINE_TYPE}]${keysText}${frameText}`;
}

function keyboardRootByNodeIndex(treeNodes: readonly SnapshotNode[]): Map<number, SnapshotNode> {
  const byIndex = new Map(treeNodes.map((node) => [node.index, node]));
  const rootByIndex = new Map<number, SnapshotNode>();
  const resolved = new Map<number, SnapshotNode | null>();
  const resolve = (node: SnapshotNode): SnapshotNode | null => {
    const cached = resolved.get(node.index);
    if (cached !== undefined) return cached;
    resolved.set(node.index, null);
    let root: SnapshotNode | null = null;
    if (isAndroidInputMethodNode(node)) {
      root = androidInputMethodRunRoot(node, byIndex);
    } else {
      const parent =
        typeof node.parentIndex === 'number' ? byIndex.get(node.parentIndex) : undefined;
      if (normalizeType(node.type ?? '') === 'keyboard') root = node;
      else if (parent) root = resolve(parent);
    }
    resolved.set(node.index, root);
    return root;
  };
  for (const node of treeNodes) {
    const root = resolve(node);
    if (root) rootByIndex.set(node.index, root);
  }
  return rootByIndex;
}

/**
 * Android package membership is per node: a parent chain can cross windows, so the run root is the
 * topmost IME-owned node reached through IME-owned parents only.
 */
function androidInputMethodRunRoot(
  node: SnapshotNode,
  byIndex: ReadonlyMap<number, SnapshotNode>,
): SnapshotNode {
  let current = node;
  const visited = new Set<number>([current.index]);
  while (typeof current.parentIndex === 'number') {
    const parent = byIndex.get(current.parentIndex);
    if (!parent || visited.has(parent.index) || !isAndroidInputMethodNode(parent)) break;
    visited.add(parent.index);
    current = parent;
  }
  return current;
}

function keyboardKeyLabels(
  treeNodes: readonly SnapshotNode[],
  rootByIndex: ReadonlyMap<number, SnapshotNode>,
): Map<number, string[]> {
  const labelsByRoot = new Map<number, Set<string>>();
  for (const node of treeNodes) {
    const root = rootByIndex.get(node.index);
    if (!root || root.index === node.index) continue;
    if (node.rect && !isPositiveFiniteRect(node.rect)) continue;
    const label = (node.label?.trim() || node.value?.trim() || '').replaceAll(/\s+/g, ' ');
    if (!label) continue;
    const labels = labelsByRoot.get(root.index) ?? new Set<string>();
    labels.add(/\s/.test(label) ? JSON.stringify(label) : label);
    labelsByRoot.set(root.index, labels);
  }
  return new Map([...labelsByRoot].map(([index, labels]) => [index, [...labels]]));
}
