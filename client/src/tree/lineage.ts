import type { Tree } from "./types";

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
