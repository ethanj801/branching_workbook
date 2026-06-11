/**
 * Factory helpers for constructing tree nodes. `branchNode` builds a fresh
 * child node and stamps it with a hash of its root→parent context (for
 * stale-ancestor detection); `nodeId` and `nowEpoch` are the id/clock
 * primitives it uses, also injected into the tree-mutation helpers.
 */
import type { SamplerBody } from "../api";
import { contextHash } from "./hash";
import type { ChatRole, NodeSource, TreeNode } from "./types";

export function nodeId(): string {
  return crypto.randomUUID();
}

export function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

export function branchNode(
  parentId: string,
  text: string,
  source: NodeSource,
  hidden: boolean,
  priorText: string,
  modelId?: string,
  samplerSnapshot?: SamplerBody,
  role: ChatRole = "user",
  endOfTurn = false,
): TreeNode {
  return {
    id: nodeId(),
    parentId,
    text,
    name: null,
    source,
    role,
    endOfTurn,
    hidden,
    deleted: false,
    starred: false,
    createdAt: nowEpoch(),
    priorContextHash: contextHash(priorText),
    modelId,
    samplerSnapshot,
  };
}
