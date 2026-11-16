import { formatRole } from '@agent-device/capture-kit/snapshot-lines';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';

const DERIVED_LABEL_ROLES: ReadonlySet<string> = new Set(['button', 'cell']);
const TEXT_ROLE = 'text';

/**
 * Display text for buttons and cells that have no label or value: the first non-empty static text
 * among their descendants, in tree order. iOS can publish a suggestion button with its words only
 * on child text nodes, and a bare `[button]` line gives the reader nothing to choose by.
 *
 * Text only: the node keeps no label, so `label=` does not match this text. `treeNodes` is the whole
 * tree, because an interactive presentation can hide the child text the label comes from.
 */
export function deriveChildTextLabels(
  displayedNodes: readonly SnapshotNode[],
  treeNodes: readonly SnapshotNode[],
): Map<number, string> {
  const derived = new Map<number, string>();
  const candidates = displayedNodes.filter(needsDerivedLabel);
  if (candidates.length === 0) return derived;
  const childrenByIndex = new Map<number, SnapshotNode[]>();
  for (const node of treeNodes) {
    if (typeof node.parentIndex !== 'number') continue;
    const siblings = childrenByIndex.get(node.parentIndex) ?? [];
    siblings.push(node);
    childrenByIndex.set(node.parentIndex, siblings);
  }
  for (const node of candidates) {
    const text = firstDescendantText(node, childrenByIndex);
    if (text) derived.set(node.index, text);
  }
  return derived;
}

function needsDerivedLabel(node: SnapshotNode): boolean {
  if (node.label?.trim() || node.value?.trim()) return false;
  if (node.inheritsLabel === true) return false;
  return DERIVED_LABEL_ROLES.has(formatRole(node.type ?? 'Element'));
}

function firstDescendantText(
  node: SnapshotNode,
  childrenByIndex: ReadonlyMap<number, readonly SnapshotNode[]>,
): string | undefined {
  const visited = new Set<number>([node.index]);
  const pending = [...(childrenByIndex.get(node.index) ?? [])].reverse();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current.index)) continue;
    visited.add(current.index);
    if (formatRole(current.type ?? 'Element') === TEXT_ROLE) {
      const text = current.label?.trim() || current.value?.trim();
      if (text) return text;
    }
    const children = childrenByIndex.get(current.index) ?? [];
    for (let i = children.length - 1; i >= 0; i -= 1) pending.push(children[i]!);
  }
  return undefined;
}
