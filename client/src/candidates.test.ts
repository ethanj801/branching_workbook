import { describe, it, expect } from "vitest";
import { applyChoice, emptyCandidates } from "./candidates";
import type { CompletionChoice } from "./api";

function choice(
  index: number,
  text: string,
  finish_reason: string | null = null,
): CompletionChoice {
  return { index, text, finish_reason };
}

describe("emptyCandidates", () => {
  it("returns n distinct blank candidates", () => {
    const list = emptyCandidates(3);
    expect(list).toHaveLength(3);
    expect(list.every((c) => c.text === "" && !c.done && c.finishReason === null)).toBe(
      true,
    );
    list[0].text = "mutated";
    expect(list[1].text).toBe(""); // not the same object reference
  });
});

describe("applyChoice", () => {
  it("appends a chunk's text to its slot", () => {
    const after = applyChoice(emptyCandidates(1), choice(0, "Hello"), 1);
    const more = applyChoice(after, choice(0, " world"), 1);
    expect(more[0].text).toBe("Hello world");
    expect(more[0].done).toBe(false);
  });

  it("marks the slot done and records the finish reason", () => {
    const after = applyChoice(emptyCandidates(1), choice(0, "x", "stop"), 1);
    expect(after[0]).toEqual({ text: "x", done: true, finishReason: "stop" });
  });

  it("only touches the choice's own slot", () => {
    const start = applyChoice(emptyCandidates(3), choice(0, "a"), 3);
    const after = applyChoice(start, choice(2, "c"), 3);
    expect(after.map((candidate) => candidate.text)).toEqual(["a", "", "c"]);
  });

  it("grows a shorter list to n slots before applying", () => {
    const after = applyChoice([], choice(1, "y"), 3);
    expect(after).toHaveLength(3);
    expect(after[1].text).toBe("y");
    expect(after[0].text).toBe("");
  });
});
