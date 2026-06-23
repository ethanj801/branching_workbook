import { describe, expect, it } from "vitest";
import type { ChatRole, TreeNode } from "../tree/types";
import {
  buildChatTranscript,
  buildChatTranscriptWithDrafts,
  chatTranscriptFilename,
} from "./exportTranscript";
import type { ChatTurn } from "./turns";

function makeNode(id: string, role: ChatRole, text: string): TreeNode {
  return {
    id,
    parentId: "root",
    text,
    name: null,
    source: "user_written",
    role,
    endOfTurn: true,
    hidden: false,
    deleted: false,
    starred: false,
    createdAt: 0,
    priorContextHash: "0".repeat(16),
  };
}

function makeSystemNode(text: string): TreeNode {
  return makeNode("system", "system", text);
}

function turn(role: ChatRole, text: string): ChatTurn {
  return { role, nodes: [], text, endOfTurn: true };
}

function turnWithFirstNode(id: string, role: ChatRole, text: string): ChatTurn {
  return { role, nodes: [makeNode(id, role, text)], text, endOfTurn: true };
}

describe("buildChatTranscript", () => {
  it("renders system prompt and turns with role labels", () => {
    const text = buildChatTranscript(makeSystemNode("Be helpful."), [
      turn("user", "Hi there"),
      turn("assistant", "Hello!"),
    ]);
    expect(text).toBe("SYSTEM:\nBe helpful.\n\nYOU:\nHi there\n\nASSISTANT:\nHello!\n");
  });

  it("omits the system block when there is no system prompt", () => {
    expect(buildChatTranscript(null, [turn("user", "Hi")])).toBe("YOU:\nHi\n");
    expect(buildChatTranscript(makeSystemNode("   "), [turn("user", "Hi")])).toBe(
      "YOU:\nHi\n",
    );
  });

  it("skips system-role turns and trims each block", () => {
    const text = buildChatTranscript(null, [
      turn("system", "ignored"),
      turn("user", "  spaced  "),
    ]);
    expect(text).toBe("YOU:\nspaced\n");
  });
});

describe("buildChatTranscriptWithDrafts", () => {
  it("exports the visible system and turn drafts", () => {
    const text = buildChatTranscriptWithDrafts(
      "Draft system.",
      [
        turnWithFirstNode("u1", "user", "Saved user"),
        turnWithFirstNode("a1", "assistant", "Saved assistant"),
      ],
      {
        u1: { text: "Draft user", baseText: "Saved user" },
        a1: { text: "Draft assistant", baseText: "Saved assistant" },
      },
    );

    expect(text).toBe(
      "SYSTEM:\nDraft system.\n\nYOU:\nDraft user\n\nASSISTANT:\nDraft assistant\n",
    );
  });

  it("omits an unsaved cleared system prompt", () => {
    const text = buildChatTranscriptWithDrafts(
      "",
      [turnWithFirstNode("u1", "user", "Hi")],
      {},
    );

    expect(text).toBe("YOU:\nHi\n");
  });
});

describe("chatTranscriptFilename", () => {
  it("sanitizes the project title into a .txt filename", () => {
    expect(chatTranscriptFilename("My Chat: Draft #2")).toBe("My-Chat-Draft-2.txt");
  });

  it("falls back to chat.txt when the title is missing or empty", () => {
    expect(chatTranscriptFilename(null)).toBe("chat.txt");
    expect(chatTranscriptFilename("   ")).toBe("chat.txt");
  });
});
