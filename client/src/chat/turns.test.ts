import { describe, expect, it } from "vitest";
import type { ChatRole, TreeNode } from "../tree/types";
import { canGenerateAssistantFromTail, foldChatTurns } from "./turns";

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
