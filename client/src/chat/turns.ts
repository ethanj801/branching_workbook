import type { ChatRole, Tree, TreeNode } from "../tree/types";

export type ChatTurn = {
  role: ChatRole;
  nodes: TreeNode[];
  text: string;
  endOfTurn: boolean;
};

// Fold a chain of TreeNodes into ChatTurns. Adjacent same-role nodes are
// merged into one turn unless the prior chunk is endOfTurn (a finalized
// turn boundary). Used for both the chat transcript view and the payload
// builder so the two stay in sync.
export function foldChatTurns(nodes: readonly TreeNode[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const node of nodes) {
    const previous = turns[turns.length - 1];
    if (!previous || previous.role !== node.role || previous.endOfTurn) {
      turns.push({
        role: node.role,
        nodes: [node],
        text: node.text,
        endOfTurn: node.endOfTurn,
      });
    } else {
      previous.nodes.push(node);
      previous.text += node.text;
      previous.endOfTurn = node.endOfTurn;
    }
  }
  return turns;
}

export function canGenerateAssistantFromTail(tail: TreeNode | null): boolean {
  if (!tail) return false;
  if (tail.role === "user") return true;
  if (tail.role === "assistant" && !tail.endOfTurn) return true;
  return false;
}

// Stricter than canGenerateAssistantFromTail: only allow appending a
// blank assistant chunk when the path ends in a finalized user turn.
// With an unfinished assistant tail, foldChatTurns would merge the new
// empty node into the existing assistant turn — the focus effect keys
// off the *first* node of the turn so focus would never land, and the
// tree would accumulate invisible empty children. The user can edit
// the in-progress chunk directly in that case.
export function canAddAssistantChunkFromTail(tail: TreeNode | null): boolean {
  return tail?.role === "user";
}

// Apply an edit to a turn that already has descendants. The fork is
// inserted as a sibling of the turn's first node (preserving the prior
// wording as its own branch in loom fashion), and every direct child of
// the turn's last node is re-parented onto the fork so the chat path
// downstream of the edit stays visible instead of getting orphaned
// under the now-stale original.
//
// Returns the next tree plus the list of moved child ids (useful for
// callers that want to refresh state keyed by node id).
export function applyChatTurnEditFork(
  tree: Tree,
  turn: ChatTurn,
  fork: TreeNode,
): { tree: Tree; movedChildIds: string[] } {
  const lastNode = turn.nodes[turn.nodes.length - 1];
  const nodes: Record<string, TreeNode> = { ...tree.nodes, [fork.id]: fork };
  const movedChildIds: string[] = [];
  if (lastNode) {
    for (const node of Object.values(tree.nodes)) {
      if (node.parentId === lastNode.id) {
        nodes[node.id] = { ...node, parentId: fork.id };
        movedChildIds.push(node.id);
      }
    }
  }
  return { tree: { rootId: tree.rootId, nodes }, movedChildIds };
}
