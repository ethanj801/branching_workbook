import { describe, expect, it } from "vitest";

import { emptyCandidates } from "../candidates";
import { applyDrop, cycleIndex } from "./useCandidates";

describe("cycleIndex", () => {
  it("advances within range", () => {
    expect(cycleIndex(0, 1, 3)).toBe(1);
    expect(cycleIndex(1, 1, 3)).toBe(2);
  });
  it("wraps forward past the end", () => {
    expect(cycleIndex(2, 1, 3)).toBe(0);
  });
  it("wraps backward past the start", () => {
    expect(cycleIndex(0, -1, 3)).toBe(2);
    expect(cycleIndex(1, -1, 3)).toBe(0);
  });
});

describe("applyDrop", () => {
  it("returns null when dropping the last remaining candidate", () => {
    expect(applyDrop(emptyCandidates(1), {}, 0, 0, 0)).toBeNull();
  });

  it("removes the candidate and shifts later saved ids down", () => {
    const result = applyDrop(emptyCandidates(3), { 0: "a", 2: "c" }, null, 0, 1);
    if (!result) throw new Error("expected a non-empty result");
    expect(result.candidates).toHaveLength(2);
    expect(result.savedCandidateIds).toEqual({ 0: "a", 1: "c" });
  });

  it("drops the saved id of the removed candidate", () => {
    const result = applyDrop(emptyCandidates(3), { 1: "b" }, null, 0, 1);
    if (!result) throw new Error("expected a non-empty result");
    expect(result.savedCandidateIds).toEqual({});
  });

  it("clears picked when the picked candidate is dropped", () => {
    const result = applyDrop(emptyCandidates(3), {}, 1, 0, 1);
    if (!result) throw new Error("expected a non-empty result");
    expect(result.pickedCandidateIndex).toBeNull();
  });

  it("shifts picked down when an earlier candidate is dropped", () => {
    const result = applyDrop(emptyCandidates(3), {}, 2, 0, 0);
    if (!result) throw new Error("expected a non-empty result");
    expect(result.pickedCandidateIndex).toBe(1);
  });

  it("leaves picked when a later candidate is dropped", () => {
    const result = applyDrop(emptyCandidates(3), {}, 0, 0, 2);
    if (!result) throw new Error("expected a non-empty result");
    expect(result.pickedCandidateIndex).toBe(0);
  });

  it("keeps the visible index on a valid slot", () => {
    // dropping the visible slot lands on the same position, clamped to the end
    const onVisible = applyDrop(emptyCandidates(3), {}, null, 2, 2);
    expect(onVisible?.visibleCandidateIndex).toBe(1);
    // dropping before the visible slot shifts it down
    const before = applyDrop(emptyCandidates(3), {}, null, 2, 0);
    expect(before?.visibleCandidateIndex).toBe(1);
    // dropping after the visible slot leaves it where it was
    const after = applyDrop(emptyCandidates(3), {}, null, 0, 2);
    expect(after?.visibleCandidateIndex).toBe(0);
  });
});
