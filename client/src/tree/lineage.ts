import type { Tree } from "./types";

/**
 * The descendants of `anchorId` that a "hide non-starred paths" prune would
 * hide. A descendant survives when it sits on the lineage of a visible star
 * inside the subtree (the spine from the anchor down to the star, plus
 * everything beneath the star) or when it lies on the current path. Already
 * hidden and deleted nodes are excluded since there is nothing to change.
 * With no stars in the subtree every eligible descendant is returned.
 */
export function prunableDescendants(
  tree: Tree,
  anchorId: string,
  currentPathIds: ReadonlySet<string>,
): string[] {
  const childrenByParent: Record<string, string[]> = {};
  for (const node of Object.values(tree.nodes)) {
    if (node.parentId === null) continue;
    (childrenByParent[node.parentId] ??= []).push(node.id);
  }

  const descendants: string[] = [];
  const stack = [...(childrenByParent[anchorId] ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    descendants.push(id);
    stack.push(...(childrenByParent[id] ?? []));
  }

  const starIds = descendants.filter((id) => {
    const node = tree.nodes[id];
    return node && node.starred && !node.hidden && !node.deleted;
  });
  const kept = expandLineage(tree, starIds);

  return descendants.filter((id) => {
    const node = tree.nodes[id];
    if (!node || node.hidden || node.deleted) return false;
    return !kept.has(id) && !currentPathIds.has(id);
  });
}

/**
 * Expand a set of seed node ids to the lineage worth showing when a filter
 * (starred, search) keeps those seeds: the seeds themselves plus every ancestor
 * (so the path back to the root stays visible) and every descendant (so the
 * subtree beneath a kept node stays reachable). Returns a fresh set.
 */
export function expandLineage(tree: Tree, seedIds: Iterable<string>): Set<string> {
  const seeds = [...seedIds];
  const lineage = new Set<string>();

  // Ancestors: walk parentId up from each seed until the root or a node already
  // covered.
  for (const id of seeds) {
    let cur: string | null | undefined = id;
    while (cur && !lineage.has(cur)) {
      lineage.add(cur);
      cur = tree.nodes[cur]?.parentId ?? null;
    }
  }

  // Descendants: BFS down a parent→children index from each seed.
  const childrenByParent: Record<string, string[]> = {};
  for (const node of Object.values(tree.nodes)) {
    if (node.parentId === null) continue;
    (childrenByParent[node.parentId] ??= []).push(node.id);
  }
  const stack = [...seeds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const childId of childrenByParent[id] ?? []) {
      if (lineage.has(childId)) continue;
      lineage.add(childId);
      stack.push(childId);
    }
  }

  return lineage;
}
