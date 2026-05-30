import { describe, expect, it } from "vitest";

import type { TabbyModel } from "../api";
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TOKENS_PER_SUGGESTION,
  branchGridColumns,
  clampNumber,
  maxBranchesForModel,
  parseBranchCountInput,
  parsePositiveInt,
  resolveBranchCount,
  resolveMaxTokens,
  resolveTokensPerSuggestion,
} from "./branchControls";

/** A TabbyModel stub exposing only the field maxBranchesForModel reads. */
function fakeModel(maxBatchSize?: number): TabbyModel {
  return {
    parameters: maxBatchSize === undefined ? {} : { max_batch_size: maxBatchSize },
  } as unknown as TabbyModel;
}

describe("clampNumber", () => {
  it("passes through values already in range", () => {
    expect(clampNumber(5, 1, 10)).toBe(5);
  });
  it("clamps to the bounds", () => {
    expect(clampNumber(0, 1, 10)).toBe(1);
    expect(clampNumber(99, 1, 10)).toBe(10);
  });
});

describe("parsePositiveInt", () => {
  it("parses positive integers", () => {
    expect(parsePositiveInt("3", 7)).toBe(3);
  });
  it("truncates trailing decimals the way parseInt does", () => {
    expect(parsePositiveInt("5.7", 7)).toBe(5);
  });
  it("falls back on zero, negatives, and garbage", () => {
    expect(parsePositiveInt("0", 7)).toBe(7);
    expect(parsePositiveInt("-2", 7)).toBe(7);
    expect(parsePositiveInt("abc", 7)).toBe(7);
    expect(parsePositiveInt("", 7)).toBe(7);
  });
});

describe("parseBranchCountInput", () => {
  it("parses a positive integer, trimming whitespace", () => {
    expect(parseBranchCountInput(" 4 ")).toBe(4);
  });
  it("accepts leading zeros", () => {
    expect(parseBranchCountInput("007")).toBe(7);
  });
  it("rejects zero, negatives, decimals, and non-digits", () => {
    expect(parseBranchCountInput("0")).toBeNull();
    expect(parseBranchCountInput("-1")).toBeNull();
    expect(parseBranchCountInput("1.5")).toBeNull();
    expect(parseBranchCountInput("")).toBeNull();
    expect(parseBranchCountInput("abc")).toBeNull();
  });
});

describe("maxBranchesForModel", () => {
  it("uses the default limit with no model", () => {
    expect(maxBranchesForModel(null)).toBe(12);
  });
  it("uses the default limit when max_batch_size is missing or not finite", () => {
    expect(maxBranchesForModel(fakeModel())).toBe(12);
    expect(maxBranchesForModel(fakeModel(Number.NaN))).toBe(12);
  });
  it("uses the model's max_batch_size when present", () => {
    expect(maxBranchesForModel(fakeModel(5))).toBe(5);
  });
  it("truncates and caps at the UI limit", () => {
    expect(maxBranchesForModel(fakeModel(3.9))).toBe(3);
    expect(maxBranchesForModel(fakeModel(100))).toBe(12);
  });
});

describe("branchGridColumns", () => {
  it("maps known counts to readable column layouts", () => {
    expect(branchGridColumns(1)).toBe(1);
    expect(branchGridColumns(4)).toBe(2);
    expect(branchGridColumns(7)).toBe(4);
    expect(branchGridColumns(9)).toBe(3);
  });
  it("returns null for counts outside the lookup", () => {
    expect(branchGridColumns(0)).toBeNull();
    expect(branchGridColumns(10)).toBeNull();
  });
});

describe("resolveBranchCount", () => {
  it("accepts an in-range count without a hint", () => {
    expect(resolveBranchCount("3", 12)).toEqual({
      ok: true,
      value: 3,
      limitHint: false,
    });
  });
  it("clamps an over-ceiling count and flags the hint", () => {
    expect(resolveBranchCount("20", 12)).toEqual({
      ok: true,
      value: 12,
      limitHint: true,
    });
  });
  it("accepts leading zeros", () => {
    expect(resolveBranchCount("007", 12)).toEqual({
      ok: true,
      value: 7,
      limitHint: false,
    });
  });
  it("errors on invalid input, naming the ceiling", () => {
    expect(resolveBranchCount("0", 12)).toEqual({
      ok: false,
      error: "Enter 1-12 branches.",
    });
    expect(resolveBranchCount("abc", 8)).toEqual({
      ok: false,
      error: "Enter 1-8 branches.",
    });
  });
});

describe("resolveMaxTokens", () => {
  it("accepts an in-range value", () => {
    expect(resolveMaxTokens("256", 8192)).toEqual({
      value: 256,
      limitHint: false,
      error: null,
      ceiling: 8192,
    });
  });
  it("clamps to the model context ceiling and flags the hint", () => {
    expect(resolveMaxTokens("999999", 8192)).toEqual({
      value: 8192,
      limitHint: true,
      error: null,
      ceiling: 8192,
    });
  });
  it("falls back to a generous ceiling with no model", () => {
    const res = resolveMaxTokens("500", null);
    expect(res.value).toBe(500);
    expect(res.error).toBeNull();
    expect(res.ceiling).toBe(32768);
  });
  it("snaps garbage and zero to the default with an error", () => {
    for (const text of ["abc", "0", "", "-5"]) {
      const res = resolveMaxTokens(text, 8192);
      expect(res.value).toBe(DEFAULT_MAX_TOKENS);
      expect(res.limitHint).toBe(false);
      // Wording is locale-formatted (e.g. "8,192"); assert shape, not digits.
      expect(res.error).toMatch(/^Enter 1-[\d.,]+ tokens\.$/);
    }
  });
});

describe("resolveTokensPerSuggestion", () => {
  it("passes through in-range values", () => {
    expect(resolveTokensPerSuggestion("2")).toBe(2);
    expect(resolveTokensPerSuggestion("8")).toBe(8);
  });
  it("clamps above the max", () => {
    expect(resolveTokensPerSuggestion("100")).toBe(8);
  });
  it("falls back to the default on invalid input", () => {
    expect(resolveTokensPerSuggestion("0")).toBe(DEFAULT_TOKENS_PER_SUGGESTION);
    expect(resolveTokensPerSuggestion("abc")).toBe(DEFAULT_TOKENS_PER_SUGGESTION);
    expect(resolveTokensPerSuggestion("-5")).toBe(DEFAULT_TOKENS_PER_SUGGESTION);
  });
});
