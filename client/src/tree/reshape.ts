import { contextHash } from "./hash";
import {
  concatPathText,
  pathFromRoot,
  type Tree,
  type TreeNode,
} from "./types";

function longestCommonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

function findDescendantPathMatchingText(
  nodes: Record<string, TreeNode>,
  anchorId: string,
  text: string,
): TreeNode[] | null {
  const childrenOf = (nodeId: string) =>
    Object.values(nodes).filter((n) => n.parentId === nodeId);

  const search = (
    node: TreeNode,
    remaining: string,
    path: TreeNode[],
  ): TreeNode[] | null => {
    if (!remaining.startsWith(node.text)) return null;

    const nextRemaining = remaining.slice(node.text.length);
    const nextPath = [...path, node];
    if (nextRemaining === "") return nextPath;

    for (const child of childrenOf(node.id)) {
      const found = search(child, nextRemaining, nextPath);
      if (found) return found;
    }
    return null;
  };

  for (const child of childrenOf(anchorId)) {
    const found = search(child, text, []);
    if (found) return found;
  }
  return null;
}

export type ReshapeOptions = {
  newId: () => string;
  now: () => number;
  source?: "user_written" | "composed";
};

export type ReshapeResult = {
  tree: Tree;
  currentId: string;
};

/**
 * Reshape the tree to match `buffer` against the currently-active path (the
 * root→currentId text concatenation). Implements spec §3.1:
 *
 *   1. LCP of buffer and active-path text finds the anchor offset.
 *   2. If the anchor falls strictly inside a node, that node is split at the
 *      offset; first half becomes a new user-written node, second half keeps
 *      the original source and inherits the original's children.
 *   3. The divergent suffix becomes a new user-written (or composed) child of
 *      the anchor. If an existing child's text already matches the suffix
 *      (e.g., a hidden sibling from an earlier generation), reattach to it
 *      instead of duplicating.
 *
 * Nothing is ever destroyed — the second half of a split keeps all descendants
 * of the original node, so rejected directions remain recoverable.
 */
export function reshape(
  tree: Tree,
  currentId: string,
  buffer: string,
  opts: ReshapeOptions,
): ReshapeResult {
  const source: "user_written" | "composed" = opts.source ?? "user_written";
  const path = pathFromRoot(tree, currentId);
  const activeText = concatPathText(path);
  const lcpLen = longestCommonPrefix(buffer, activeText);

  // No-op: buffer is identical to the active path
  if (lcpLen === activeText.length && lcpLen === buffer.length) {
    return { tree, currentId };
  }

  const nodesCopy: Record<string, TreeNode> = { ...tree.nodes };
  let anchorId: string | null = null;
  let cumulative = 0;

  for (let i = 0; i < path.length; i++) {
    const node = path[i];
    const nodeStart = cumulative;
    const nodeEnd = cumulative + node.text.length;

    if (lcpLen <= nodeEnd) {
      if (lcpLen === nodeEnd) {
        // Anchor aligns exactly with this node's end — no split
        anchorId = node.id;
      } else {
        const localOffset = lcpLen - nodeStart;
        if (localOffset === 0) {
          // Aligns with this node's start — anchor is its parent
          anchorId = node.parentId;
        } else {
          // Split this node at localOffset
          const firstHalfId = opts.newId();
          const secondHalfId = opts.newId();
          const parentOfOrig = node.parentId;

          const priorText =
            parentOfOrig !== null
              ? concatPathText(
                  pathFromRoot(
                    { nodes: nodesCopy, rootId: tree.rootId },
                    parentOfOrig,
                  ),
                )
              : "";

          const firstHalf: TreeNode = {
            id: firstHalfId,
            parentId: parentOfOrig,
            text: node.text.slice(0, localOffset),
            source: "user_written",
            hidden: false,
            createdAt: opts.now(),
            priorContextHash: contextHash(priorText),
          };
          const secondHalf: TreeNode = {
            id: secondHalfId,
            parentId: firstHalfId,
            text: node.text.slice(localOffset),
            source: node.source,
            hidden: node.hidden,
            createdAt: opts.now(),
            priorContextHash: contextHash(priorText + firstHalf.text),
            samplerSnapshot: node.samplerSnapshot,
            seed: node.seed,
            modelId: node.modelId,
          };

          nodesCopy[firstHalfId] = firstHalf;
          nodesCopy[secondHalfId] = secondHalf;
          // Reparent original's children onto secondHalf
          for (const [id, n] of Object.entries(nodesCopy)) {
            if (n.parentId === node.id) {
              nodesCopy[id] = { ...n, parentId: secondHalfId };
            }
          }
          delete nodesCopy[node.id];

          anchorId = firstHalfId;
        }
      }
      break;
    }
    cumulative = nodeEnd;
  }

  if (anchorId === null) {
    // Fallback: shouldn't happen in well-formed input, but default to root
    anchorId = tree.rootId;
  }

  const divergent = buffer.slice(lcpLen);

  if (divergent === "") {
    return {
      tree: { nodes: nodesCopy, rootId: tree.rootId },
      currentId: anchorId,
    };
  }

  // Reattach if an existing descendant path already has the divergent text.
  const existingPath = findDescendantPathMatchingText(
    nodesCopy,
    anchorId,
    divergent,
  );
  if (existingPath) {
    for (const node of existingPath) {
      nodesCopy[node.id] = { ...node, hidden: false };
    }
    return {
      tree: { nodes: nodesCopy, rootId: tree.rootId },
      currentId: existingPath[existingPath.length - 1].id,
    };
  }

  // Create a new user-written (or composed) child
  const newId = opts.newId();
  const priorText = concatPathText(
    pathFromRoot({ nodes: nodesCopy, rootId: tree.rootId }, anchorId),
  );
  const newNode: TreeNode = {
    id: newId,
    parentId: anchorId,
    text: divergent,
    source,
    hidden: false,
    createdAt: opts.now(),
    priorContextHash: contextHash(priorText),
  };
  nodesCopy[newId] = newNode;

  return {
    tree: { nodes: nodesCopy, rootId: tree.rootId },
    currentId: newId,
  };
}
