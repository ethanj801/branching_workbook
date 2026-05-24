import { describe, expect, it } from "vitest";
import type { ChatRole, TreeNode } from "../tree/types";
import type { Tree } from "../tree/types";
import {
  applyChatTurnEditFork,
  canAddAssistantChunkFromTail,
  canGenerateAssistantFromTail,
  foldChatTurns,
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
