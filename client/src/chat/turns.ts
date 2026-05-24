import { concatPathText, pathFromRoot } from "../tree/types";
import type { ChatRole, Tree, TreeNode } from "../tree/types";

export type ChatTurn = {
  role: ChatRole;
  nodes: TreeNode[];
  text: string;
  endOfTurn: boolean;
};

// Starting from a node, walk forward through the tree picking the
// first same-role child at each step until either endOfTurn is set
// or no same-role child exists. Heuristic — when a node has multiple
// same-role children (alternative continuations) it may pick the
// wrong one. Callers that have a baseText snapshot of what the user
// was editing should use foldChainMatchingBaseText instead.
export function foldChainFromFirst(tree: Tree, firstNodeId: string): TreeNode[] {
  const start = tree.nodes[firstNodeId];
  if (!start) return [];
  const chain: TreeNode[] = [start];
  let current = start;
  while (!current.endOfTurn) {
    const next = Object.values(tree.nodes).find(
      (n) => n.parentId === current.id && n.role === current.role,
    );
    if (!next) break;
    chain.push(next);
    current = next;
  }
  return chain;
}

// Walk every same-role chain from firstNode and return the one whose
// concatenated text exactly equals baseText. Returns null if zero or
// more than one candidate matches — in either case the caller should
// bail rather than guess, because picking the wrong continuation
// would attach the draft's fork to the wrong subtree (descendants
// would stay under the stale original and the fork would become a
// dead leaf). A candidate chain must end naturally — either at an
// endOfTurn=true node or where no same-role continuation exists —
// so we don't accept a prefix of a longer chain.
export function foldChainMatchingBaseText(
  tree: Tree,
  firstNodeId: string,
  baseText: string,
): TreeNode[] | null {
  const start = tree.nodes[firstNodeId];
  if (!start) return null;

  const matches: TreeNode[][] = [];

  function walk(chain: TreeNode[], textSoFar: string): void {
    const last = chain[chain.length - 1];
    if (textSoFar === baseText) {
      const hasSameRoleContinuation =
        !last.endOfTurn &&
        Object.values(tree.nodes).some(
          (n) => n.parentId === last.id && n.role === last.role,
        );
      if (!hasSameRoleContinuation) matches.push(chain);
      return;
    }
    if (!baseText.startsWith(textSoFar)) return;
    if (last.endOfTurn) return;
    const sameRoleChildren = Object.values(tree.nodes).filter(
      (n) => n.parentId === last.id && n.role === last.role,
    );
    for (const child of sameRoleChildren) {
      walk([...chain, child], textSoFar + child.text);
    }
  }

  walk([start], start.text);

  return matches.length === 1 ? matches[0] : null;
}

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

// A pending edit on a turn editor: `text` is what the textarea
// currently shows, `baseText` is the full folded turn text captured
// when the user first started typing. Comparing the two avoids two
// multi-chunk hazards: (a) a never-edited multi-chunk turn whose
// concat text trivially differs from its first node's text would
// otherwise look dirty forever; (b) editing the merged text down to
// exactly the first chunk's text would otherwise look clean and get
// dropped on close.
export type ChatTurnDraft = {
  text: string;
  baseText: string;
};

// Returns true iff any chat draft (turn or system) differs from the
// snapshot the user started editing against. Iterates the full draft
// map rather than just turns on the active path so a draft the user
// navigated away from still counts as unsaved. Drafts whose anchor
// node has been removed from the tree don't count.
export function hasUnsavedChatDrafts(
  tree: Tree | null,
  systemNode: TreeNode | null,
  systemDraft: string,
  turnDrafts: Readonly<Record<string, ChatTurnDraft>>,
): boolean {
  if (!tree) return false;
  if (systemNode && systemDraft !== systemNode.text) return true;
  for (const [id, draft] of Object.entries(turnDrafts)) {
    if (!tree.nodes[id]) continue;
    if (draft.text !== draft.baseText) return true;
  }
  return false;
}

export type ChatDraftCommitDeps = {
  newNodeId: () => string;
  now: () => number;
  contextHash: (text: string) => string;
};

export type ChatDraftCommitResult = {
  tree: Tree;
  currentId: string;
  consumedTurnDraftIds: string[];
  systemDraftCommitted: boolean;
};

// Apply every dirty draft in one tree update. On-path turns are
// processed top-down using the supplied folded turns (so multi-chunk
// turns commit as a single fork). Any draft whose first node is not
// covered by those active-path turns — an "off-path" draft that
// survived an earlier commit failure or unusual navigation — is then
// committed as a synthetic single-node turn, so Save / Cmd+S can
// actually clear the project's dirty state instead of leaving it
// permanently flagged.
//
// Each draft carries a baseText snapshot (what the turn looked like
// when the user first started editing); commit is a no-op when text
// matches baseText (the user reverted their edit), regardless of
// whether the underlying tree's first node matches.
//
// Empty drafts on a turn that started non-empty are skipped — the
// user shouldn't accidentally delete a turn by emptying its text.
export function commitChatDrafts(
  tree: Tree,
  currentId: string,
  turns: readonly ChatTurn[],
  drafts: Readonly<Record<string, ChatTurnDraft>>,
  systemEdit: { nodeId: string; text: string } | null,
  deps: ChatDraftCommitDeps,
): ChatDraftCommitResult {
  let working: Tree = tree;
  let nextCurrentId = currentId;
  const consumedTurnDraftIds: string[] = [];
  let systemDraftCommitted = false;

  if (systemEdit) {
    const sysNode = working.nodes[systemEdit.nodeId];
    if (sysNode && sysNode.text !== systemEdit.text) {
      working = {
        rootId: working.rootId,
        nodes: {
          ...working.nodes,
          [sysNode.id]: { ...sysNode, text: systemEdit.text, endOfTurn: true },
        },
      };
      systemDraftCommitted = true;
    }
  }

  function applyDraftToTurn(turn: ChatTurn, draft: ChatTurnDraft): boolean {
    if (draft.text === draft.baseText) return false;
    if (!draft.text.trim() && draft.baseText.length > 0) return false;

    const firstId = turn.nodes[0]?.id;
    if (!firstId) return false;
    const firstNode = working.nodes[firstId];
    if (!firstNode || firstNode.parentId === null) return false;
    const lastTurnNodeId = turn.nodes[turn.nodes.length - 1]?.id;
    if (!lastTurnNodeId) return false;
    const lastNode = working.nodes[lastTurnNodeId];
    if (!lastNode) return false;

    const lastHasChildren = Object.values(working.nodes).some(
      (n) => n.parentId === lastNode.id,
    );
    const canInPlace = turn.nodes.length === 1 && !lastHasChildren;

    if (canInPlace) {
      working = {
        rootId: working.rootId,
        nodes: {
          ...working.nodes,
          [firstId]: {
            ...firstNode,
            text: draft.text,
            endOfTurn: turn.role === "user" ? true : firstNode.endOfTurn,
          },
        },
      };
      return true;
    }

    const priorText = concatPathText(pathFromRoot(working, firstNode.parentId));
    const fork: TreeNode = {
      id: deps.newNodeId(),
      parentId: firstNode.parentId,
      text: draft.text,
      name: null,
      source: turn.role === "assistant" ? "composed" : "user_written",
      role: turn.role,
      endOfTurn: turn.role === "user",
      hidden: false,
      deleted: false,
      starred: false,
      createdAt: deps.now(),
      priorContextHash: deps.contextHash(priorText),
    };
    const { tree: nextWorking } = applyChatTurnEditFork(working, turn, fork);
    working = nextWorking;

    // If the previous tail was downstream of this turn it now reaches
    // through the fork via the reparented chain — leave nextCurrentId
    // alone. If the turn was the tail itself (no descendants moved),
    // land on the fork.
    if (nextCurrentId === lastNode.id) {
      nextCurrentId = fork.id;
    }
    return true;
  }

  for (const turn of turns) {
    const firstId = turn.nodes[0]?.id;
    if (!firstId) continue;
    const draft = drafts[firstId];
    if (!draft) continue;
    if (applyDraftToTurn(turn, draft)) consumedTurnDraftIds.push(firstId);
  }

  // Off-path drafts: any draft we didn't reach via the active-path
  // turns. Reconstruct the turn the user was editing using the
  // draft's baseText to pick exactly the chain whose concat matches.
  // Without that disambiguation a node with multiple same-role
  // children (alternative continuations kept from an earlier
  // generation) would let us guess the wrong chain and produce a
  // fork attached to the wrong subtree — descendants would stay
  // under the stale original and the fork would become a dead leaf.
  // If baseText matches zero or multiple chains we skip the draft;
  // the user can navigate back to the matching branch and commit on
  // path, or discard via Escape.
  const consumed = new Set(consumedTurnDraftIds);
  for (const [firstId, draft] of Object.entries(drafts)) {
    if (consumed.has(firstId)) continue;
    const firstNode = working.nodes[firstId];
    if (!firstNode || firstNode.parentId === null) continue;
    const chain = foldChainMatchingBaseText(working, firstId, draft.baseText);
    if (!chain || chain.length === 0) continue;
    const last = chain[chain.length - 1];
    const syntheticTurn: ChatTurn = {
      role: firstNode.role,
      nodes: chain,
      text: chain.map((n) => n.text).join(""),
      endOfTurn: last.endOfTurn,
    };
    if (applyDraftToTurn(syntheticTurn, draft)) consumedTurnDraftIds.push(firstId);
  }

  return {
    tree: working,
    currentId: nextCurrentId,
    consumedTurnDraftIds,
    systemDraftCommitted,
  };
}
