import { childrenOf, type Tree, type TreeNode } from "./types";

export type StarredNavigationOptions = {
  includeHidden?: boolean;
};

function byCreatedThenId(a: TreeNode, b: TreeNode): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

function treeNavigationOrder(tree: Tree): Map<string, number> {
  const order = new Map<string, number>();
  let index = 0;

  function visit(nodeId: string) {
    const node = tree.nodes[nodeId];
    if (!node || node.deleted || order.has(nodeId)) return;
    order.set(nodeId, index);
    index += 1;

    for (const child of childrenOf(tree, nodeId)
      .filter((candidate) => !candidate.deleted)
      .sort(byCreatedThenId)) {
      visit(child.id);
    }
  }

  visit(tree.rootId);
  return order;
}

export function starredNavigationNodes(
  tree: Tree,
  { includeHidden = true }: StarredNavigationOptions = {},
): TreeNode[] {
  const order = treeNavigationOrder(tree);
  return Object.values(tree.nodes)
    .filter((node) => node.starred)
    .filter((node) => !node.deleted)
    .filter((node) => includeHidden || !node.hidden)
    .sort((a, b) => {
      const aOrder = order.get(a.id) ?? Number.POSITIVE_INFINITY;
      const bOrder = order.get(b.id) ?? Number.POSITIVE_INFINITY;
      return aOrder - bOrder || byCreatedThenId(a, b);
    });
}
