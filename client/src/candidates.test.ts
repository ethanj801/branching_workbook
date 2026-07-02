import { describe, it, expect } from "vitest";
import {
  appendToCandidate,
  applyChoice,
  emptyCandidates,
  foldChunk,
  isCandidateUsable,
  markCandidateDone,
  markCandidateFailed,
  seededCandidates,
  usableCandidateText,
} from "./candidates";
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
    list[0]!.text = "mutated";
    expect(list[1]!.text).toBe(""); // not the same object reference
  });
});

describe("applyChoice", () => {
  it("appends a chunk's text to its slot", () => {
    const after = applyChoice(emptyCandidates(1), choice(0, "Hello"), 1);
    const more = applyChoice(after, choice(0, " world"), 1);
    expect(more[0]!.text).toBe("Hello world");
    expect(more[0]!.done).toBe(false);
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
    expect(after[1]!.text).toBe("y");
    expect(after[0]!.text).toBe("");
  });
});

describe("foldChunk", () => {
  it("appends text to a fixed slot and grows the list to n", () => {
    const after = foldChunk([], 1, "hi", null, 3);
    expect(after).toHaveLength(3);
    expect(after[1]!.text).toBe("hi");
    expect(after[0]!.text).toBe("");
    expect(after[1]!.done).toBe(false);
  });

  it("records the finish reason for its slot", () => {
    const start = foldChunk(emptyCandidates(2), 0, "a", null, 2);
    const after = foldChunk(start, 0, "b", "stop", 2);
    expect(after[0]).toEqual({ text: "ab", done: true, finishReason: "stop" });
    expect(after[1]!.done).toBe(false);
  });
});

describe("seededCandidates", () => {
  it("pre-fills each slot with its seed token", () => {
    const list = seededCandidates([" The", " A"]);
    expect(list).toEqual([
      { text: " The", done: false, finishReason: null },
      { text: " A", done: false, finishReason: null },
    ]);
  });
});

describe("appendToCandidate", () => {
  it("appends to the fixed slot and leaves the seed in place", () => {
    const start = seededCandidates([" The", " A"]);
    const after = appendToCandidate(start, 0, " cat", null);
    expect(after[0]!.text).toBe(" The cat");
    expect(after[1]!.text).toBe(" A");
  });

  it("records the finish reason for its slot", () => {
    const after = appendToCandidate(seededCandidates([" A"]), 0, " end", "stop");
    expect(after[0]).toEqual({ text: " A end", done: true, finishReason: "stop" });
  });

  it("counts a finish-only chunk as done without changing text", () => {
    const after = appendToCandidate(seededCandidates([" A"]), 0, "", "length");
    expect(after[0]).toEqual({ text: " A", done: true, finishReason: "length" });
  });
});

describe("markCandidateDone", () => {
  it("marks one slot done and leaves others untouched", () => {
    const after = markCandidateDone(seededCandidates([" A", " B"]), 1);
    expect(after[1]!.done).toBe(true);
    expect(after[0]!.done).toBe(false);
  });

  it("returns the input unchanged for an out-of-range slot", () => {
    const start = seededCandidates([" A"]);
    expect(markCandidateDone(start, 5)).toBe(start);
  });
});

describe("markCandidateFailed", () => {
  it("marks one slot done and failed, leaving others untouched", () => {
    const after = markCandidateFailed(seededCandidates([" A", " B"]), 0);
    expect(after[0]).toEqual({
      text: " A",
      done: true,
      finishReason: null,
      failed: true,
    });
    expect(after[1]!.failed).toBeUndefined();
  });

  it("returns the input unchanged for an out-of-range slot", () => {
    const start = seededCandidates([" A"]);
    expect(markCandidateFailed(start, 5)).toBe(start);
  });
});

describe("isCandidateUsable", () => {
  it("accepts a candidate with text that did not fail", () => {
    expect(isCandidateUsable({ text: " A", done: true, finishReason: "stop" })).toBe(
      true,
    );
  });

  it("rejects empty, failed, and missing candidates", () => {
    expect(isCandidateUsable({ text: "", done: true, finishReason: null })).toBe(false);
    expect(
      isCandidateUsable({ text: " A", done: true, finishReason: null, failed: true }),
    ).toBe(false);
    expect(isCandidateUsable(undefined)).toBe(false);
    expect(isCandidateUsable(null)).toBe(false);
  });
});

describe("usableCandidateText", () => {
  it("returns the text for a usable candidate without setting an error", () => {
    let error: string | null = null;
    const text = usableCandidateText(
      { text: " A", done: true, finishReason: "stop" },
      "using",
      (msg) => (error = msg),
    );
    expect(text).toBe(" A");
    expect(error).toBeNull();
  });

  it("returns null and reports a failed slot regardless of verb", () => {
    let error: string | null = null;
    const text = usableCandidateText(
      { text: " A", done: true, finishReason: null, failed: true },
      "keeping",
      (msg) => (error = msg),
    );
    expect(text).toBeNull();
    expect(error).toBe("This branch failed to generate. Pick another.");
  });

  it("returns null and words the empty-slot message with the verb", () => {
    let error: string | null = null;
    expect(
      usableCandidateText(
        { text: "", done: true, finishReason: null },
        "using",
        (msg) => (error = msg),
      ),
    ).toBeNull();
    expect(error).toBe("Select a branch with text before using it.");

    usableCandidateText(undefined, "keeping", (msg) => (error = msg));
    expect(error).toBe("Select a branch with text before keeping it.");
  });
});
