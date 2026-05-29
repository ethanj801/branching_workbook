import { sortedChildrenOf } from "../nodeMapLayout";
import { childrenOf, type Tree, type TreeNode } from "./types";

/**
 * Pure structural tree operations the node map performs on a selection:
 * analysing whether a selection is a mergeable linear run, collecting the
 * nodes a merge/delete will touch, and building the merged trees. Kept free of
 * React/App state so they can be unit-tested directly.
 */

export type NodeMapMergeAnalysis =
  | { ok: true; orderedIds: string[] }
  | { ok: false; reason: string };

/** Decide whether `selectedIds` form one linear parent→child run we can merge. */
export function analyzeNodeMapMergeSelection(
  tree: Tree,
  selectedIds: string[],
): NodeMapMergeAnalysis {
  const uniqueIds = [...new Set(selectedIds)].filter((id) => tree.nodes[id]);
  if (uniqueIds.length < 2) {
    return { ok: false, reason: "Select at least two connected nodes." };
  }

  const selected = new Set(uniqueIds);
  const upstreamIds = uniqueIds.filter((id) => {
    const parentId = tree.nodes[id]?.parentId;
    return parentId === null || !selected.has(parentId);
  });

  if (upstreamIds.length !== 1) {
    return { ok: false, reason: "Selection must be one linear parent-child run." };
  }

  const upstream = tree.nodes[upstreamIds[0]];
  if (!upstream || upstream.parentId === null) {
    return { ok: false, reason: "Root cannot be merged." };
  }

  const orderedIds: string[] = [];
  let current: TreeNode | undefined = upstream;
  while (current && selected.has(current.id)) {
    orderedIds.push(current.id);
    const allChildren = sortedChildrenOf(tree, current.id);
    const selectedChildren = allChildren.filter((child) => selected.has(child.id));
    if (selectedChildren.length === 0) break;
    if (selectedChildren.length > 1 || allChildren.length !== 1) {
      return {
        ok: false,
        reason: "Cannot merge through a node with multiple children.",
      };
    }
    current = selectedChildren[0];
  }

  if (orderedIds.length !== uniqueIds.length) {
    return { ok: false, reason: "Selection must be one linear parent-child run." };
  }

  return { ok: true, orderedIds };
}

/** Walk down from `startId` while each node has exactly one child. */
export function collectLinearChainDownward(tree: Tree, startId: string): string[] {
  const chain: string[] = [];
  let cursor: string | null = startId;
  while (cursor) {
    const node = tree.nodes[cursor];
    if (!node) break;
    chain.push(cursor);
    const children = childrenOf(tree, cursor);
    if (children.length !== 1) break;
    cursor = children[0].id;
  }
  return chain;
}

/** Every node id in the subtree rooted at `nodeIdToCollect` (inclusive). */
export function collectSubtreeNodeIds(tree: Tree, nodeIdToCollect: string): string[] {
  const collected: string[] = [];
  const stack = [nodeIdToCollect];
  while (stack.length > 0) {
    const nodeIdFromStack = stack.pop()!;
    if (!tree.nodes[nodeIdFromStack]) continue;
    collected.push(nodeIdFromStack);
    for (const child of childrenOf(tree, nodeIdFromStack)) {
      stack.push(child.id);
    }
  }
  return collected;
}

/** Merge a single-child `downstream` node up into its `upstream` parent. */
export function buildMergedTree(
  baseTree: Tree,
  upstreamId: string,
  downstreamId: string,
): Tree | null {
  const upstream = baseTree.nodes[upstreamId];
  const downstream = baseTree.nodes[downstreamId];
  if (!upstream || !downstream || downstream.parentId !== upstream.id) return null;
  if (upstream.parentId === null) return null;
  if (childrenOf(baseTree, upstream.id).length !== 1) return null;

  const nextNodes = { ...baseTree.nodes };
  const merged: TreeNode = {
    ...upstream,
    text: `${upstream.text}${downstream.text}`,
    name: upstream.name ?? downstream.name ?? null,
    source: upstream.source === downstream.source ? upstream.source : "composed",
    starred: upstream.starred || downstream.starred,
  };

  for (const child of childrenOf(baseTree, downstream.id)) {
    nextNodes[child.id] = { ...child, parentId: upstream.id };
  }
  nextNodes[upstream.id] = merged;
  delete nextNodes[downstream.id];

  return {
    rootId: baseTree.rootId,
    nodes: nextNodes,
  };
}

/** Merge a whole validated linear run (`orderedIds`) into its first node. */
export function buildMergedSelectionTree(
  baseTree: Tree,
  orderedIds: string[],
): Tree | null {
  const analysis = analyzeNodeMapMergeSelection(baseTree, orderedIds);
  if (!analysis.ok) return null;

  const orderedNodes = analysis.orderedIds.map((id) => baseTree.nodes[id]);
  const upstream = orderedNodes[0];
  const downstream = orderedNodes[orderedNodes.length - 1];
  if (!upstream || !downstream) return null;

  const nextNodes = { ...baseTree.nodes };
  const firstSource = upstream.source;
  const sameSource = orderedNodes.every((node) => node.source === firstSource);
  const merged: TreeNode = {
    ...upstream,
    text: orderedNodes.map((node) => node.text).join(""),
    name: orderedNodes.find((node) => node.name?.trim())?.name ?? null,
    source: sameSource ? firstSource : "composed",
    starred: orderedNodes.some((node) => node.starred),
    hidden: orderedNodes.every((node) => node.hidden),
  };

  for (const child of childrenOf(baseTree, downstream.id)) {
    nextNodes[child.id] = { ...child, parentId: upstream.id };
  }
  nextNodes[upstream.id] = merged;
  for (const node of orderedNodes.slice(1)) {
    delete nextNodes[node.id];
  }

  return {
    rootId: baseTree.rootId,
    nodes: nextNodes,
  };
}
