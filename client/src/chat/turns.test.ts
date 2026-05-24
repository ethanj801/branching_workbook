import { describe, expect, it } from "vitest";
import type { ChatRole, TreeNode } from "../tree/types";
import type { Tree } from "../tree/types";
import { pathFromRoot } from "../tree/types";
import {
  applyChatTurnEditFork,
  canAddAssistantChunkFromTail,
  canGenerateAssistantFromTail,
  commitChatDrafts,
  foldChainFromFirst,
  foldChainMatchingBaseText,
  foldChatTurns,
  hasUnsavedChatDrafts,
  isDraftCommitable,
  isDraftDirty,
} from "./turns";

function makeNode(
  id: string,
  parentId: string | null,
  role: ChatRole,
  text: string,
  endOfTurn = false,
): TreeNode {
  return {
    id,
    parentId,
    text,
    name: null,
    source: "user_written",
    role,
    endOfTurn,
    hidden: false,
    deleted: false,
    starred: false,
    createdAt: 0,
    priorContextHash: "0".repeat(16),
  };
}

describe("foldChatTurns", () => {
  it("groups consecutive same-role chunks into one turn", () => {
    const turns = foldChatTurns([
      makeNode("a1", "root", "assistant", "Hello "),
      makeNode("a2", "a1", "assistant", "world."),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("Hello world.");
    expect(turns[0].nodes.map((n) => n.id)).toEqual(["a1", "a2"]);
  });

  it("starts a new turn when endOfTurn is set on the prior chunk", () => {
    const turns = foldChatTurns([
      makeNode("u1", "root", "user", "Hi", true),
      makeNode("u2", "u1", "user", "Are you there?", true),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0].text).toBe("Hi");
    expect(turns[1].text).toBe("Are you there?");
  });

  it("starts a new turn when role changes", () => {
    const turns = foldChatTurns([
      makeNode("u1", "root", "user", "Hi", true),
      makeNode("a1", "u1", "assistant", "Hello"),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe("user");
    expect(turns[1].role).toBe("assistant");
  });

  it("preserves an empty hand-added assistant chunk as its own turn", () => {
    // Regression: when a user clicks Add assistant on a finalized user
    // turn, the new chunk has text="" and endOfTurn=false. It must
    // appear as a separate, empty assistant turn so the editor renders.
    const turns = foldChatTurns([
      makeNode("u1", "root", "user", "Hi", true),
      makeNode("a-new", "u1", "assistant", ""),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[1].role).toBe("assistant");
    expect(turns[1].text).toBe("");
    expect(turns[1].endOfTurn).toBe(false);
  });

  it("inherits endOfTurn from the last chunk of a merged turn", () => {
    const turns = foldChatTurns([
      makeNode("a1", "root", "assistant", "part one "),
      makeNode("a2", "a1", "assistant", "part two", true),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].endOfTurn).toBe(true);
  });
});

describe("foldChainFromFirst", () => {
  it("returns just the start node when it's already endOfTurn", () => {
    const root = makeNode("root", null, "user", "");
    const u1 = makeNode("u1", "root", "user", "hi", true);
    const tree = makeTree(root, u1);
    expect(foldChainFromFirst(tree, "u1").map((n) => n.id)).toEqual(["u1"]);
  });

  it("walks same-role children until endOfTurn", () => {
    const root = makeNode("root", null, "user", "");
    const a1 = makeNode("a1", "root", "assistant", "Hello ");
    const a2 = makeNode("a2", "a1", "assistant", "world.", true);
    const u1 = makeNode("u1", "a2", "user", "thanks", true);
    const tree = makeTree(root, a1, a2, u1);
    expect(foldChainFromFirst(tree, "a1").map((n) => n.id)).toEqual(["a1", "a2"]);
  });

  it("stops at the first node with no same-role child", () => {
    const root = makeNode("root", null, "user", "");
    const a1 = makeNode("a1", "root", "assistant", "partial");
    const tree = makeTree(root, a1);
    expect(foldChainFromFirst(tree, "a1").map((n) => n.id)).toEqual(["a1"]);
  });

  it("returns empty when the start node is missing", () => {
    const root = makeNode("root", null, "user", "");
    const tree = makeTree(root);
    expect(foldChainFromFirst(tree, "ghost")).toEqual([]);
  });
});

describe("foldChainMatchingBaseText", () => {
  it("returns the unique chain whose concat equals baseText", () => {
    const root = makeNode("root", null, "user", "");
    const a1 = makeNode("a1", "root", "assistant", "Hello ");
    const a2 = makeNode("a2", "a1", "assistant", "world.", true);
    const tree = makeTree(root, a1, a2);
    const chain = foldChainMatchingBaseText(tree, "a1", "Hello world.");
    expect(chain?.map((n) => n.id)).toEqual(["a1", "a2"]);
  });

  it("picks the matching continuation when sibling alternatives exist", () => {
    // Regression for the off-path arbitrary-pick bug: a length-stopped
    // assistant turn (a1) has two kept continuations (a2 used in the
    // active path, a2_alt kept as a sibling alternative). A draft
    // whose baseText is "Hello world." must land on the a1→a2 chain;
    // first-child-only would pick whichever sibling came first in
    // tree iteration order and produce a dead-leaf fork.
    const root = makeNode("root", null, "user", "");
    const a1 = makeNode("a1", "root", "assistant", "Hello ");
    const a2 = makeNode("a2", "a1", "assistant", "world.", true);
    const a2_alt = makeNode("a2_alt", "a1", "assistant", "there.", true);
    const tree = makeTree(root, a1, a2, a2_alt);
    const chain = foldChainMatchingBaseText(tree, "a1", "Hello world.");
    expect(chain?.map((n) => n.id)).toEqual(["a1", "a2"]);
  });

  it("returns null when no chain matches baseText", () => {
    const root = makeNode("root", null, "user", "");
    const a1 = makeNode("a1", "root", "assistant", "Hello ");
    const a2 = makeNode("a2", "a1", "assistant", "world.", true);
    const tree = makeTree(root, a1, a2);
    // baseText snapshot is stale: chain reads "Hello world." but
    // the snapshot says something else entirely.
    expect(foldChainMatchingBaseText(tree, "a1", "Goodbye world.")).toBeNull();
  });

  it("returns null when two distinct chains both match baseText", () => {
    // Pathological but possible: two kept continuations whose chains
    // happen to read the same text. We can't pick one safely.
    const root = makeNode("root", null, "user", "");
    const a1 = makeNode("a1", "root", "assistant", "Hello ");
    const a2 = makeNode("a2", "a1", "assistant", "world.", true);
    const a2_dup = makeNode("a2_dup", "a1", "assistant", "world.", true);
    const tree = makeTree(root, a1, a2, a2_dup);
    expect(foldChainMatchingBaseText(tree, "a1", "Hello world.")).toBeNull();
  });

  it("does not return a strict prefix of a longer matching chain", () => {
    // If a1 alone matches baseText but a1 has a same-role continuation
    // (it's not endOfTurn), a1 isn't really a complete turn. We must
    // require the candidate to end naturally.
    const root = makeNode("root", null, "user", "");
    const a1 = makeNode("a1", "root", "assistant", "Hello", false);
    const a2 = makeNode("a2", "a1", "assistant", " world.", true);
    const tree = makeTree(root, a1, a2);
    // The full chain reads "Hello world.", not "Hello". So a draft
    // with baseText="Hello" against an a1 that has a same-role
    // continuation doesn't match any valid candidate chain.
    expect(foldChainMatchingBaseText(tree, "a1", "Hello")).toBeNull();
  });

  it("accepts a single-node chain when the node is endOfTurn", () => {
    const root = makeNode("root", null, "user", "");
    const u1 = makeNode("u1", "root", "user", "hi", true);
    const tree = makeTree(root, u1);
    expect(foldChainMatchingBaseText(tree, "u1", "hi")?.map((n) => n.id)).toEqual([
      "u1",
    ]);
  });

  it("skips hidden continuations when picking a chain", () => {
    // Off-path drafts are reconstructed via this fold; if a sibling
    // chain that the user hid still participated in matching, an
    // edit would commit a fork onto an invisible branch the user
    // can't navigate to or see.
    const root = makeNode("root", null, "user", "");
    const a1 = makeNode("a1", "root", "assistant", "Hello ");
    const a2 = makeNode("a2", "a1", "assistant", "world.", true);
    const a2_hidden = makeNode("a2_hidden", "a1", "assistant", "world.", true);
    a2_hidden.hidden = true;
    const tree = makeTree(root, a1, a2, a2_hidden);
    // Without filtering this would be ambiguous (two matching chains)
    // and return null; the hidden sibling should be ignored so the
    // visible chain wins cleanly.
    const chain = foldChainMatchingBaseText(tree, "a1", "Hello world.");
    expect(chain?.map((n) => n.id)).toEqual(["a1", "a2"]);
  });

  it("skips deleted continuations when picking a chain", () => {
    const root = makeNode("root", null, "user", "");
    const a1 = makeNode("a1", "root", "assistant", "Hello ");
    const a2 = makeNode("a2", "a1", "assistant", "world.", true);
    const a2_dead = makeNode("a2_dead", "a1", "assistant", "world.", true);
    a2_dead.deleted = true;
    const tree = makeTree(root, a1, a2, a2_dead);
    const chain = foldChainMatchingBaseText(tree, "a1", "Hello world.");
    expect(chain?.map((n) => n.id)).toEqual(["a1", "a2"]);
  });

  it("returns null when the only matching chain is hidden", () => {
    // If the visible tree has no chain matching baseText, the fold
    // must still bail rather than fall through to a hidden one —
    // the draft belongs to a branch the user can no longer see.
    const root = makeNode("root", null, "user", "");
    const a1 = makeNode("a1", "root", "assistant", "Hello ");
    const a2_hidden = makeNode("a2_hidden", "a1", "assistant", "world.", true);
    a2_hidden.hidden = true;
    const tree = makeTree(root, a1, a2_hidden);
    expect(foldChainMatchingBaseText(tree, "a1", "Hello world.")).toBeNull();
  });
});

describe("canGenerateAssistantFromTail", () => {
  it("returns false when there is no tail", () => {
    expect(canGenerateAssistantFromTail(null)).toBe(false);
  });

  it("returns true for a user tail (assistant should respond)", () => {
    expect(
      canGenerateAssistantFromTail(makeNode("u1", "root", "user", "Hi", true)),
    ).toBe(true);
  });

  it("returns true for an in-progress assistant tail", () => {
    expect(
      canGenerateAssistantFromTail(
        makeNode("a1", "root", "assistant", "thinking…", false),
      ),
    ).toBe(true);
  });

  it("returns false for a finalized assistant tail", () => {
    expect(
      canGenerateAssistantFromTail(makeNode("a1", "root", "assistant", "done.", true)),
    ).toBe(false);
  });

  it("returns false for a system tail", () => {
    expect(
      canGenerateAssistantFromTail(
        makeNode("s1", "root", "system", "be helpful", true),
      ),
    ).toBe(false);
  });
});

describe("canAddAssistantChunkFromTail", () => {
  it("returns true only when the tail is a user turn", () => {
    expect(
      canAddAssistantChunkFromTail(makeNode("u1", "root", "user", "Hi", true)),
    ).toBe(true);
  });

  it("returns false for an unfinished assistant tail", () => {
    // Regression: an unfinished assistant tail (e.g. a length-stopped
    // generation) used to look enabled because canGenerateAssistantFromTail
    // returns true. Appending then would have been silently folded into
    // the existing turn — invisible empty node, no focus.
    expect(
      canAddAssistantChunkFromTail(
        makeNode("a1", "root", "assistant", "cut off mid", false),
      ),
    ).toBe(false);
  });

  it("returns false for a finalized assistant tail", () => {
    expect(
      canAddAssistantChunkFromTail(makeNode("a1", "root", "assistant", "done.", true)),
    ).toBe(false);
  });

  it("returns false for a system tail", () => {
    expect(
      canAddAssistantChunkFromTail(
        makeNode("s1", "root", "system", "be helpful", true),
      ),
    ).toBe(false);
  });

  it("returns false when there is no tail", () => {
    expect(canAddAssistantChunkFromTail(null)).toBe(false);
  });
});

function makeTree(...nodes: ReturnType<typeof makeNode>[]): Tree {
  return {
    rootId: nodes[0].id,
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
  };
}

describe("applyChatTurnEditFork", () => {
  it("reparents the edited turn's immediate children onto the fork", () => {
    // Tree: root → user("hi") → assistant("hello")
    // Editing the user turn must move the assistant under the fork so
    // the chat keeps showing the assistant reply.
    const root = makeNode("root", null, "user", "");
    const user = makeNode("u1", "root", "user", "hi", true);
    const assistant = makeNode("a1", "u1", "assistant", "hello", true);
    const tree = makeTree(root, user, assistant);
    const turn = foldChatTurns([user])[0];
    const fork = makeNode("u-fork", "root", "user", "hi (edited)", true);

    const { tree: next, movedChildIds } = applyChatTurnEditFork(tree, turn, fork);
    expect(movedChildIds).toEqual(["a1"]);
    expect(next.nodes["a1"].parentId).toBe("u-fork");
    // Original user node is preserved as a now-childless sibling.
    expect(next.nodes["u1"].text).toBe("hi");
    expect(next.nodes["u1"].parentId).toBe("root");
    expect(Object.values(next.nodes).filter((n) => n.parentId === "u1")).toHaveLength(
      0,
    );
    expect(next.nodes["u-fork"]).toBe(fork);
  });

  it("reparents from the last node of a multi-chunk turn", () => {
    // Multi-chunk assistant turn a1→a2→a3 ; user message u1 after.
    // Editing the merged turn must move u1 from a3 to fork, while
    // leaving the a1→a2→a3 chain intact as the prior wording branch.
    const root = makeNode("root", null, "user", "");
    const a1 = makeNode("a1", "root", "assistant", "alpha ");
    const a2 = makeNode("a2", "a1", "assistant", "beta ");
    const a3 = makeNode("a3", "a2", "assistant", "gamma", true);
    const u1 = makeNode("u1", "a3", "user", "thanks", true);
    const tree = makeTree(root, a1, a2, a3, u1);
    const turn = foldChatTurns([a1, a2, a3])[0];
    const fork = makeNode("a-fork", "root", "assistant", "rewritten", false);

    const { tree: next, movedChildIds } = applyChatTurnEditFork(tree, turn, fork);
    expect(movedChildIds).toEqual(["u1"]);
    expect(next.nodes["u1"].parentId).toBe("a-fork");
    expect(next.nodes["a1"].parentId).toBe("root");
    expect(next.nodes["a2"].parentId).toBe("a1");
    expect(next.nodes["a3"].parentId).toBe("a2");
  });

  it("moves every immediate child when the edited turn has alternative branches", () => {
    // u1 has two assistant responses (a, a') kept as alternatives.
    // The user accepts that editing u1 moves both to the fork; the
    // prior wording becomes a childless sibling.
    const root = makeNode("root", null, "user", "");
    const u1 = makeNode("u1", "root", "user", "hi", true);
    const a = makeNode("a", "u1", "assistant", "hello");
    const aAlt = makeNode("a-alt", "u1", "assistant", "hi back");
    const tree = makeTree(root, u1, a, aAlt);
    const turn = foldChatTurns([u1])[0];
    const fork = makeNode("u-fork", "root", "user", "howdy", true);

    const { tree: next, movedChildIds } = applyChatTurnEditFork(tree, turn, fork);
    expect(movedChildIds.sort()).toEqual(["a", "a-alt"]);
    expect(next.nodes["a"].parentId).toBe("u-fork");
    expect(next.nodes["a-alt"].parentId).toBe("u-fork");
    expect(Object.values(next.nodes).filter((n) => n.parentId === "u1")).toHaveLength(
      0,
    );
  });

  it("just inserts the fork when the edited turn has no descendants", () => {
    // Childless multi-chunk turn — fork stands alone, nothing to move.
    const root = makeNode("root", null, "user", "");
    const a1 = makeNode("a1", "root", "assistant", "one ");
    const a2 = makeNode("a2", "a1", "assistant", "two");
    const tree = makeTree(root, a1, a2);
    const turn = foldChatTurns([a1, a2])[0];
    const fork = makeNode("a-fork", "root", "assistant", "rewritten", false);

    const { tree: next, movedChildIds } = applyChatTurnEditFork(tree, turn, fork);
    expect(movedChildIds).toEqual([]);
    expect(next.nodes["a-fork"]).toBe(fork);
    // Original chain still intact.
    expect(next.nodes["a1"].parentId).toBe("root");
    expect(next.nodes["a2"].parentId).toBe("a1");
  });
});

function makeStubDeps() {
  let idCounter = 0;
  let nowCounter = 1000;
  return {
    newNodeId: () => `fork-${++idCounter}`,
    now: () => ++nowCounter,
    contextHash: (text: string) => `h(${text.length})`,
  };
}

// Small constructor for the new {text, baseText} draft shape so the
// tests don't have to spell out both fields every time.
function draft(text: string, baseText: string) {
  return { text, baseText };
}

describe("commitChatDrafts", () => {
  it("is a no-op when nothing is dirty", () => {
    const root = makeNode("root", null, "user", "");
    const u1 = makeNode("u1", "root", "user", "hi", true);
    const a1 = makeNode("a1", "u1", "assistant", "hello", true);
    const tree = makeTree(root, u1, a1);
    const turns = foldChatTurns([u1, a1]);

    const result = commitChatDrafts(tree, "a1", turns, {}, null, makeStubDeps());
    expect(result.tree).toBe(tree); // identity preserved on no-op
    expect(result.currentId).toBe("a1");
    expect(result.consumedTurnDraftIds).toEqual([]);
    expect(result.systemDraftCommitted).toBe(false);
  });

  it("updates a leaf turn in place when it has no descendants", () => {
    const root = makeNode("root", null, "user", "");
    const u1 = makeNode("u1", "root", "user", "hi", true);
    const a1 = makeNode("a1", "u1", "assistant", "hello", true);
    const tree = makeTree(root, u1, a1);
    const turns = foldChatTurns([u1, a1]);

    const result = commitChatDrafts(
      tree,
      "a1",
      turns,
      { a1: draft("hello there", "hello") },
      null,
      makeStubDeps(),
    );
    expect(result.consumedTurnDraftIds).toEqual(["a1"]);
    // No fork created — a1 is single-node leaf.
    expect(Object.keys(result.tree.nodes).sort()).toEqual(["a1", "root", "u1"]);
    expect(result.tree.nodes["a1"].text).toBe("hello there");
    expect(result.currentId).toBe("a1");
  });

  it("forks an upstream dirty turn and keeps the chain through fork", () => {
    const root = makeNode("root", null, "user", "");
    const u1 = makeNode("u1", "root", "user", "hi", true);
    const a1 = makeNode("a1", "u1", "assistant", "hello", true);
    const tree = makeTree(root, u1, a1);
    const turns = foldChatTurns([u1, a1]);

    const result = commitChatDrafts(
      tree,
      "a1",
      turns,
      { u1: draft("hi (edited)", "hi") },
      null,
      makeStubDeps(),
    );
    expect(result.consumedTurnDraftIds).toEqual(["u1"]);
    expect(result.currentId).toBe("a1"); // still the leaf, reparented under fork
    expect(result.tree.nodes["fork-1"].text).toBe("hi (edited)");
    expect(result.tree.nodes["a1"].parentId).toBe("fork-1");
    // Original u1 preserved as a childless sibling.
    expect(result.tree.nodes["u1"].text).toBe("hi");
    expect(
      Object.values(result.tree.nodes).filter((n) => n.parentId === "u1"),
    ).toHaveLength(0);
  });

  it("commits multiple dirty turns top-down with the chain rewired through each fork", () => {
    // root → u1 → a1 → u2 → a2  (a2 is the leaf)
    // Edit u1 AND u2; both fork. Saving top-down means u1's fork moves
    // a1 (and the chain below) onto fork-1, then u2's fork (built on
    // the already-moved chain) moves a2 onto fork-2. Final path:
    // root → fork-1 → a1 → fork-2 → a2.
    const root = makeNode("root", null, "user", "");
    const u1 = makeNode("u1", "root", "user", "q1", true);
    const a1 = makeNode("a1", "u1", "assistant", "r1", true);
    const u2 = makeNode("u2", "a1", "user", "q2", true);
    const a2 = makeNode("a2", "u2", "assistant", "r2", true);
    const tree = makeTree(root, u1, a1, u2, a2);
    const turns = foldChatTurns([u1, a1, u2, a2]);

    const result = commitChatDrafts(
      tree,
      "a2",
      turns,
      { u1: draft("Q1!", "q1"), u2: draft("Q2!", "q2") },
      null,
      makeStubDeps(),
    );
    expect(result.consumedTurnDraftIds).toEqual(["u1", "u2"]);
    expect(result.currentId).toBe("a2");
    // Validate the new path actually threads through both forks.
    const path = pathFromRoot(result.tree, "a2").map((n) => n.id);
    expect(path).toEqual(["root", "fork-1", "a1", "fork-2", "a2"]);
    // Originals preserved as childless siblings.
    expect(
      Object.values(result.tree.nodes).filter((n) => n.parentId === "u1"),
    ).toHaveLength(0);
    expect(
      Object.values(result.tree.nodes).filter((n) => n.parentId === "u2"),
    ).toHaveLength(0);
  });

  it("lands on the fork when the dirty turn was the tail itself", () => {
    // Multi-chunk assistant turn with no descendants: forking yields a
    // new leaf the user should sit on.
    const root = makeNode("root", null, "user", "");
    const a1 = makeNode("a1", "root", "assistant", "alpha ");
    const a2 = makeNode("a2", "a1", "assistant", "beta", true);
    const tree = makeTree(root, a1, a2);
    const turns = foldChatTurns([a1, a2]);

    const result = commitChatDrafts(
      tree,
      "a2",
      turns,
      { a1: draft("rewritten", "alpha beta") },
      null,
      makeStubDeps(),
    );
    expect(result.currentId).toBe("fork-1");
  });

  it("commits a dirty system edit and reports it separately", () => {
    const root = makeNode("root", null, "user", "");
    const sys = makeNode("sys", "root", "system", "be terse", true);
    const u1 = makeNode("u1", "sys", "user", "hi", true);
    const tree = makeTree(root, sys, u1);
    const turns = foldChatTurns([sys, u1]);

    const result = commitChatDrafts(
      tree,
      "u1",
      turns,
      {},
      { nodeId: "sys", text: "be helpful" },
      makeStubDeps(),
    );
    expect(result.systemDraftCommitted).toBe(true);
    expect(result.tree.nodes["sys"].text).toBe("be helpful");
    expect(result.consumedTurnDraftIds).toEqual([]);
  });

  it("skips a draft that would empty a previously non-empty turn", () => {
    const root = makeNode("root", null, "user", "");
    const u1 = makeNode("u1", "root", "user", "hi", true);
    const tree = makeTree(root, u1);
    const turns = foldChatTurns([u1]);

    const result = commitChatDrafts(
      tree,
      "u1",
      turns,
      { u1: draft("   ", "hi") },
      null,
      makeStubDeps(),
    );
    expect(result.consumedTurnDraftIds).toEqual([]);
    expect(result.tree.nodes["u1"].text).toBe("hi");
  });

  it("commits an empty save on a turn that was already empty (newly added chunk)", () => {
    // Mirror onSaveChatTurn's no-op-on-empty-started-empty branch:
    // committing an unchanged empty turn shouldn't error and shouldn't
    // bloat the tree.
    const root = makeNode("root", null, "user", "");
    const u1 = makeNode("u1", "root", "user", "hi", true);
    const a1 = makeNode("a1", "u1", "assistant", "", false);
    const tree = makeTree(root, u1, a1);
    const turns = foldChatTurns([u1, a1]);

    const result = commitChatDrafts(
      tree,
      "a1",
      turns,
      { a1: draft("", "") },
      null,
      makeStubDeps(),
    );
    // draft.text === draft.baseText, so the no-op short-circuits before
    // the empty-trim check.
    expect(result.consumedTurnDraftIds).toEqual([]);
    expect(result.tree).toBe(tree);
  });

  it("commits an off-path draft as a synthetic single-node fork", () => {
    // Active path is root → system → u_b, but the user has a draft on
    // u_a (sibling, off-path). Save must still land the edit — leaving
    // it dirty-but-unsaveable was a real dead end before this fix.
    const root = makeNode("root", null, "user", "");
    const sys = makeNode("system", "root", "system", "", true);
    const ua = makeNode("u_a", "system", "user", "branch A question", true);
    const ub = makeNode("u_b", "system", "user", "branch B question", true);
    const tree = makeTree(root, sys, ua, ub);
    // chatTurns is what the active path would fold to — only branch B.
    const turns = foldChatTurns([sys, ub]);

    const result = commitChatDrafts(
      tree,
      "u_b",
      turns,
      { u_a: draft("branch A question (edited)", "branch A question") },
      null,
      makeStubDeps(),
    );
    expect(result.consumedTurnDraftIds).toEqual(["u_a"]);
    // u_a is a single-node leaf — in-place update, no fork.
    expect(result.tree.nodes["u_a"].text).toBe("branch A question (edited)");
    // Active path tail unchanged.
    expect(result.currentId).toBe("u_b");
  });

  it("disambiguates an off-path multi-chunk draft by baseText when sibling continuations exist", () => {
    // a1 has two kept continuations: a2 ("world.") and a2_alt
    // ("there."). The user was editing the a1→a2 chain ("Hello
    // world.") off-path. Without baseText-driven chain selection
    // the commit would arbitrarily pick whichever sibling the tree
    // iterator returned first and produce a dead-leaf fork attached
    // to the wrong subtree. With baseText="Hello world." we pick a2
    // unambiguously and the fork correctly takes over a2's
    // descendants.
    const root = makeNode("root", null, "user", "");
    const sys = makeNode("system", "root", "system", "", true);
    const ub = makeNode("u_b", "system", "user", "active branch", true);
    const u1 = makeNode("u1", "system", "user", "off-path question", true);
    const a1 = makeNode("a1", "u1", "assistant", "Hello ");
    const a2 = makeNode("a2", "a1", "assistant", "world.", true);
    const u2 = makeNode("u2", "a2", "user", "follow-up", true);
    const a2_alt = makeNode("a2_alt", "a1", "assistant", "there.", true);
    const tree = makeTree(root, sys, ub, u1, a1, a2, u2, a2_alt);
    const turns = foldChatTurns([sys, ub]); // active path

    const result = commitChatDrafts(
      tree,
      "u_b",
      turns,
      { a1: draft("Hello world. (revised)", "Hello world.") },
      null,
      makeStubDeps(),
    );
    expect(result.consumedTurnDraftIds).toEqual(["a1"]);
    // Fork carries the edit and took over a2's downstream (u2).
    const fork = result.tree.nodes["fork-1"];
    expect(fork.text).toBe("Hello world. (revised)");
    expect(result.tree.nodes["u2"].parentId).toBe("fork-1");
    // a2 is preserved as a now-childless sibling under a1.
    expect(result.tree.nodes["a2"].parentId).toBe("a1");
    expect(
      Object.values(result.tree.nodes).filter((n) => n.parentId === "a2"),
    ).toHaveLength(0);
    // a2_alt is untouched (still a sibling of a2 under a1).
    expect(result.tree.nodes["a2_alt"].parentId).toBe("a1");
  });

  it("bails on an ambiguous off-path multi-chunk draft instead of guessing", () => {
    // Two sibling continuations whose chains both read the same text
    // — there's no safe pick. Skip rather than corrupt; the draft
    // stays in the map and the user can resolve by navigating to the
    // intended branch.
    const root = makeNode("root", null, "user", "");
    const sys = makeNode("system", "root", "system", "", true);
    const ub = makeNode("u_b", "system", "user", "active branch", true);
    const a1 = makeNode("a1", "sys", "assistant", "Hello ");
    const a2 = makeNode("a2", "a1", "assistant", "world.", true);
    const a2_dup = makeNode("a2_dup", "a1", "assistant", "world.", true);
    const tree = makeTree(root, sys, ub, a1, a2, a2_dup);
    const turns = foldChatTurns([sys, ub]);

    const result = commitChatDrafts(
      tree,
      "u_b",
      turns,
      { a1: draft("Hello world. (revised)", "Hello world.") },
      null,
      makeStubDeps(),
    );
    expect(result.consumedTurnDraftIds).toEqual([]);
    expect(result.tree).toBe(tree);
  });

  it("commits an off-path multi-chunk draft without dragging continuation chunks under the fork", () => {
    // Regression: synthesizing the off-path turn as a single-node
    // turn made applyChatTurnEditFork treat the continuation chunks
    // (a2, here) as downstream descendants and reparent them under
    // the new fork. Saving "Goodbye." for the off-path "Hello " →
    // "world." chain used to produce "Goodbye.world." instead of
    // just "Goodbye.".
    //
    // Build a tree where the multi-chunk assistant turn lives off the
    // active path: root → system → u_b is active, and the off-path
    // chain hangs off u_a.
    const root = makeNode("root", null, "user", "");
    const sys = makeNode("system", "root", "system", "", true);
    const ua = makeNode("u_a", "system", "user", "ask A", true);
    const ub = makeNode("u_b", "system", "user", "ask B", true);
    const a1 = makeNode("a1", "u_a", "assistant", "Hello ");
    const a2 = makeNode("a2", "a1", "assistant", "world.", true);
    const tree = makeTree(root, sys, ua, ub, a1, a2);
    // Active path is sys → u_b; the off-path turn (a1+a2) isn't in
    // these chatTurns.
    const turns = foldChatTurns([sys, ub]);

    const result = commitChatDrafts(
      tree,
      "u_b",
      turns,
      { a1: draft("Goodbye.", "Hello world.") },
      null,
      makeStubDeps(),
    );
    expect(result.consumedTurnDraftIds).toEqual(["a1"]);
    // The fork's only persisted text is the user's draft — no
    // "world." dangling underneath.
    const fork = result.tree.nodes["fork-1"];
    expect(fork.text).toBe("Goodbye.");
    const forkChildren = Object.values(result.tree.nodes).filter(
      (n) => n.parentId === "fork-1",
    );
    expect(forkChildren).toEqual([]);
    // Original chain intact as a sibling history branch.
    expect(result.tree.nodes["a1"].parentId).toBe("u_a");
    expect(result.tree.nodes["a2"].parentId).toBe("a1");
    // Active path tail unchanged.
    expect(result.currentId).toBe("u_b");
  });

  it("treats a multi-chunk turn's untouched draft as a no-op (baseText check)", () => {
    // Regression for the dirty-tracking false positive: a draft equal
    // to the full folded text (set when the user first focused the
    // editor) must not commit anything, even though it differs from
    // the first chunk's text in isolation.
    const root = makeNode("root", null, "user", "");
    const a1 = makeNode("a1", "root", "assistant", "Hello ");
    const a2 = makeNode("a2", "a1", "assistant", "world.", true);
    const tree = makeTree(root, a1, a2);
    const turns = foldChatTurns([a1, a2]);

    const result = commitChatDrafts(
      tree,
      "a2",
      turns,
      { a1: draft("Hello world.", "Hello world.") },
      null,
      makeStubDeps(),
    );
    expect(result.consumedTurnDraftIds).toEqual([]);
    expect(result.tree).toBe(tree);
  });

  it("reports skipped draft ids when a dirty draft is uncommitable (emptied turn)", () => {
    // Used to be a silent return; with the unified commit boundary the
    // skipped id is reported back so the persist caller can surface an
    // error instead of leaving the draft permadirty without explanation.
    const root = makeNode("root", null, "user", "");
    const u1 = makeNode("u1", "root", "user", "hi", true);
    const tree = makeTree(root, u1);
    const turns = foldChatTurns([u1]);

    const result = commitChatDrafts(
      tree,
      "u1",
      turns,
      { u1: draft("   ", "hi") },
      null,
      makeStubDeps(),
    );
    expect(result.consumedTurnDraftIds).toEqual([]);
    expect(result.skippedTurnDraftIds).toEqual(["u1"]);
    expect(result.tree).toBe(tree);
  });

  it("does not report a clean (non-dirty) draft as skipped", () => {
    // A draft whose text already matches baseText is a no-op, not a
    // failure — it should appear in neither bucket so the caller has
    // no reason to display an error.
    const root = makeNode("root", null, "user", "");
    const u1 = makeNode("u1", "root", "user", "hi", true);
    const tree = makeTree(root, u1);
    const turns = foldChatTurns([u1]);

    const result = commitChatDrafts(
      tree,
      "u1",
      turns,
      { u1: draft("hi", "hi") },
      null,
      makeStubDeps(),
    );
    expect(result.consumedTurnDraftIds).toEqual([]);
    expect(result.skippedTurnDraftIds).toEqual([]);
  });

  it("commits a multi-chunk turn shrunk to the first chunk's text", () => {
    // Regression for the dirty-tracking false negative: editing the
    // merged "Hello world." down to exactly "Hello " makes draft.text
    // equal a1's text in isolation but still differs from the folded
    // baseText, so it must be treated as a real edit.
    const root = makeNode("root", null, "user", "");
    const a1 = makeNode("a1", "root", "assistant", "Hello ");
    const a2 = makeNode("a2", "a1", "assistant", "world.", true);
    const tree = makeTree(root, a1, a2);
    const turns = foldChatTurns([a1, a2]);

    const result = commitChatDrafts(
      tree,
      "a2",
      turns,
      { a1: draft("Hello ", "Hello world.") },
      null,
      makeStubDeps(),
    );
    expect(result.consumedTurnDraftIds).toEqual(["a1"]);
    // Multi-chunk turn forks; original a1→a2 chain preserved as a
    // childless-sibling branch and the fork takes over the main path.
    expect(result.tree.nodes["fork-1"].text).toBe("Hello ");
    expect(result.tree.nodes["a1"].parentId).toBe("root");
    expect(result.tree.nodes["a2"].parentId).toBe("a1");
    expect(result.currentId).toBe("fork-1");
  });
});

describe("isDraftDirty / isDraftCommitable", () => {
  it("isDraftDirty is true iff text differs from baseText", () => {
    expect(isDraftDirty({ text: "hi", baseText: "hi" })).toBe(false);
    expect(isDraftDirty({ text: "hi!", baseText: "hi" })).toBe(true);
    expect(isDraftDirty({ text: "", baseText: "" })).toBe(false);
    expect(isDraftDirty({ text: "", baseText: "hi" })).toBe(true);
  });

  it("isDraftCommitable is false for clean drafts", () => {
    expect(isDraftCommitable({ text: "hi", baseText: "hi" })).toBe(false);
  });

  it("isDraftCommitable is true for ordinary edits", () => {
    expect(isDraftCommitable({ text: "hi there", baseText: "hi" })).toBe(true);
  });

  it("isDraftCommitable is false when the edit empties a previously non-empty turn", () => {
    // Saving an emptied turn would silently delete the user's text;
    // the commit path treats this as uncommitable so the user can fix
    // or revert before anything persists.
    expect(isDraftCommitable({ text: "", baseText: "hi" })).toBe(false);
    expect(isDraftCommitable({ text: "   ", baseText: "hi" })).toBe(false);
  });

  it("isDraftCommitable is true for typing into a freshly-blank assistant chunk", () => {
    // baseText === "" means the turn started empty (e.g. the Add
    // assistant chunk button), so committing text into it is fine.
    expect(isDraftCommitable({ text: "Sure!", baseText: "" })).toBe(true);
  });
});

describe("hasUnsavedChatDrafts", () => {
  it("is false when there is no tree", () => {
    expect(hasUnsavedChatDrafts(null, null, "", {})).toBe(false);
  });

  it("is false when every draft's text matches its baseText snapshot", () => {
    const root = makeNode("root", null, "user", "");
    const sys = makeNode("sys", "root", "system", "be helpful", true);
    const u1 = makeNode("u1", "sys", "user", "hi", true);
    const tree = makeTree(root, sys, u1);
    expect(
      hasUnsavedChatDrafts(tree, sys, "be helpful", { u1: draft("hi", "hi") }),
    ).toBe(false);
  });

  it("is true when the system draft differs from the system node", () => {
    const root = makeNode("root", null, "user", "");
    const sys = makeNode("sys", "root", "system", "be helpful", true);
    const tree = makeTree(root, sys);
    expect(hasUnsavedChatDrafts(tree, sys, "be terse", {})).toBe(true);
  });

  it("is true when a turn draft differs from its baseText snapshot", () => {
    const root = makeNode("root", null, "user", "");
    const u1 = makeNode("u1", "root", "user", "hi", true);
    const tree = makeTree(root, u1);
    expect(
      hasUnsavedChatDrafts(tree, null, "", { u1: draft("hi (edited)", "hi") }),
    ).toBe(true);
  });

  it("does not false-positive on a multi-chunk turn whose draft equals the full folded text", () => {
    // The textarea shows the concatenated turn text; the draft equals
    // that concat as soon as the user focuses the editor. If we
    // compared against only the first node's text the check would
    // always say dirty for multi-chunk turns.
    const root = makeNode("root", null, "user", "");
    const a1 = makeNode("a1", "root", "assistant", "Hello ");
    const a2 = makeNode("a2", "a1", "assistant", "world.", true);
    const tree = makeTree(root, a1, a2);
    expect(
      hasUnsavedChatDrafts(tree, null, "", {
        a1: draft("Hello world.", "Hello world."),
      }),
    ).toBe(false);
  });

  it("does flag a multi-chunk turn whose draft equals just the first chunk text", () => {
    // Symmetric regression: editing the merged "Hello world." down to
    // "Hello " would compare equal to a1.text in isolation but must
    // still register as dirty against the folded baseText.
    const root = makeNode("root", null, "user", "");
    const a1 = makeNode("a1", "root", "assistant", "Hello ");
    const a2 = makeNode("a2", "a1", "assistant", "world.", true);
    const tree = makeTree(root, a1, a2);
    expect(
      hasUnsavedChatDrafts(tree, null, "", {
        a1: draft("Hello ", "Hello world."),
      }),
    ).toBe(true);
  });

  it("still flags drafts whose node is not on the current active path", () => {
    // Regression: dirty check used to iterate only chatTurns (active
    // path), so editing turn X then navigating to a sibling branch
    // dropped X from the dirty check.
    const root = makeNode("root", null, "user", "");
    const u1 = makeNode("u1", "root", "user", "branch A question", true);
    const u2 = makeNode("u2", "root", "user", "branch B question", true);
    const tree = makeTree(root, u1, u2);
    expect(
      hasUnsavedChatDrafts(tree, null, "", {
        u1: draft("branch A question (edited)", "branch A question"),
      }),
    ).toBe(true);
  });

  it("ignores drafts whose node has been removed from the tree", () => {
    const root = makeNode("root", null, "user", "");
    const tree = makeTree(root);
    expect(
      hasUnsavedChatDrafts(tree, null, "", {
        ghost: draft("edit on deleted turn", ""),
      }),
    ).toBe(false);
  });
});
