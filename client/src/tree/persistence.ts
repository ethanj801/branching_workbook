import type { MutationBatch, NodeModel } from "../api";
import { pathFromRoot, type Tree, type TreeNode } from "./types";

export type LoadedTree = {
  tree: Tree;
  currentId: string;
};

function nodeFromModel(node: NodeModel): TreeNode {
  return {
    id: node.id,
    parentId: node.parent_id,
    text: node.text,
    name: node.name ?? null,
    source: node.source,
    hidden: node.hidden,
    createdAt: node.created_at,
    priorContextHash: node.prior_context_hash,
    samplerSnapshot: node.sampler_snapshot ?? undefined,
    seed: node.seed ?? undefined,
    modelId: node.model_identifier ?? undefined,
  };
}

function modelFromNode(node: TreeNode, isMainPath: boolean): NodeModel {
  return {
    id: node.id,
    parent_id: node.parentId,
    text: node.text,
    name: node.name ?? null,
    source: node.source,
    hidden: node.hidden,
    is_main_path: isMainPath,
    created_at: node.createdAt,
    prior_context_hash: node.priorContextHash,
    sampler_snapshot: node.samplerSnapshot ?? null,
    seed: node.seed ?? null,
    model_identifier: node.modelId ?? null,
  };
}

function sameNode(a: TreeNode, b: TreeNode): boolean {
  return (
    a.parentId === b.parentId &&
    a.text === b.text &&
    (a.name ?? null) === (b.name ?? null) &&
    a.source === b.source &&
    a.hidden === b.hidden &&
    a.createdAt === b.createdAt &&
    a.priorContextHash === b.priorContextHash &&
    JSON.stringify(a.samplerSnapshot ?? null) ===
      JSON.stringify(b.samplerSnapshot ?? null) &&
    (a.seed ?? null) === (b.seed ?? null) &&
    (a.modelId ?? null) === (b.modelId ?? null)
  );
}

export function loadedTreeFromModels(nodes: NodeModel[]): LoadedTree {
  const root = nodes.find((node) => node.parent_id === null);
  if (!root) throw new Error("Project has no root node.");

  const treeNodes: Record<string, TreeNode> = {};
  for (const node of nodes) {
    treeNodes[node.id] = nodeFromModel(node);
  }

  let currentId = root.id;
  while (true) {
    const next = nodes.find(
      (node) => node.parent_id === currentId && node.is_main_path,
    );
    if (!next) break;
    currentId = next.id;
  }

  return {
    tree: { nodes: treeNodes, rootId: root.id },
    currentId,
  };
}

export function mutationBatchFromTrees(
  before: Tree,
  after: Tree,
  currentId: string,
): MutationBatch {
  const mainPathIds = pathFromRoot(after, currentId).map((node) => node.id);
  const mainPath = new Set(mainPathIds);
  const creates: NodeModel[] = [];
  const updates: NodeModel[] = [];
  const deletes: string[] = [];

  for (const node of Object.values(after.nodes)) {
    const oldNode = before.nodes[node.id];
    if (!oldNode) {
      creates.push(modelFromNode(node, mainPath.has(node.id)));
    } else if (!sameNode(oldNode, node)) {
      updates.push(modelFromNode(node, mainPath.has(node.id)));
    }
  }

  for (const nodeId of Object.keys(before.nodes)) {
    if (!after.nodes[nodeId]) deletes.push(nodeId);
  }

  return {
    creates,
    updates,
    deletes,
    main_path: mainPathIds,
  };
}
