import { type Tree, type TreeNode } from "./types";

export type StarredNavigationOptions = {
  includeHidden?: boolean;
};

function byCreatedThenId(a: TreeNode, b: TreeNode): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

// Depth-first preorder over the live tree. Uses an explicit stack and a
// children index built once, so arbitrarily deep trees cannot overflow the
// call stack and each node is visited without rescanning the whole node map.
function treeNavigationOrder(tree: Tree): Map<string, number> {
  const childrenByParent = new Map<string, TreeNode[]>();
  for (const node of Object.values(tree.nodes)) {
    if (node.parentId === null || node.deleted) continue;
    const siblings = childrenByParent.get(node.parentId);
    if (siblings) siblings.push(node);
    else childrenByParent.set(node.parentId, [node]);
  }

  const order = new Map<string, number>();
  let index = 0;
  const stack = [tree.rootId];
  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    const node = tree.nodes[nodeId];
    if (!node || node.deleted || order.has(nodeId)) continue;
    order.set(nodeId, index);
    index += 1;

    // Push children in reverse so the stack pops them in sorted order.
    const children = (childrenByParent.get(nodeId) ?? []).sort(byCreatedThenId);
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i]!.id);
    }
  }
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
