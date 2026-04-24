export type NodeSource = "generated" | "user_written" | "composed";

export type TreeNode = {
  id: string;
  parentId: string | null;
  text: string;
  source: NodeSource;
  hidden: boolean;
  createdAt: number;
  priorContextHash: string;
  samplerSnapshot?: unknown;
  seed?: number;
  modelId?: string;
};

export type Tree = {
  nodes: Record<string, TreeNode>;
  rootId: string;
};

export function pathFromRoot(tree: Tree, nodeId: string): TreeNode[] {
  const path: TreeNode[] = [];
  let cur: TreeNode | undefined = tree.nodes[nodeId];
  while (cur) {
    path.unshift(cur);
    cur = cur.parentId ? tree.nodes[cur.parentId] : undefined;
  }
  return path;
}

export function concatPathText(path: TreeNode[]): string {
  return path.map((n) => n.text).join("");
}

export function childrenOf(tree: Tree, nodeId: string): TreeNode[] {
  return Object.values(tree.nodes).filter((n) => n.parentId === nodeId);
}
