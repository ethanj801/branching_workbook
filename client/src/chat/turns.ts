import type { ChatRole, TreeNode } from "../tree/types";

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
