import { describe, it, expect } from "vitest";
import {
  buildSamplerSnapshot,
  clampMinTokens,
  dropBannedOpenings,
  rankChatTop,
  rankCompletionTop,
  runSeededFanOut,
  withBannedStrings,
} from "./seeding";
import type { SamplerBody } from "../api";
import type { Candidate } from "../candidates";

const NEVER_ABORT = new AbortController().signal;
const noop = () => {};

describe("rankCompletionTop", () => {
  it("orders a token-to-logprob map from most to least likely", () => {
    const ranked = rankCompletionTop({ " A": -2.1, " The": -0.3, " It": -1.4 });
    expect(ranked).toEqual([" The", " It", " A"]);
  });

  it("returns nothing for a missing map", () => {
    expect(rankCompletionTop(null)).toEqual([]);
    expect(rankCompletionTop(undefined)).toEqual([]);
  });
});

describe("rankChatTop", () => {
  it("orders a list of leaves from most to least likely", () => {
    const ranked = rankChatTop([
      { token: " A", logprob: -2.1 },
      { token: " The", logprob: -0.3 },
      { token: " It", logprob: -1.4 },
    ]);
    expect(ranked).toEqual([" The", " It", " A"]);
  });

  it("returns nothing for a missing list", () => {
    expect(rankChatTop(undefined)).toEqual([]);
  });
});

describe("withBannedStrings", () => {
  it("returns the body untouched when there is nothing to add", () => {
    const body: SamplerBody = { temperature: 0.8 };
    expect(withBannedStrings(body, [])).toBe(body);
  });

  it("adds the project list when the sampler had no bans", () => {
    const out = withBannedStrings({ temperature: 0.8 }, ["suddenly", "a chill"]);
    expect(out.banned_strings).toEqual(["suddenly", "a chill"]);
    expect(out.temperature).toBe(0.8);
  });

  it("unions with the sampler's own bans, case-insensitively deduped", () => {
    const out = withBannedStrings({ banned_strings: ["Suddenly", "rictus"] }, [
      "suddenly",
      "a chill",
    ]);
    expect(out.banned_strings).toEqual(["Suddenly", "rictus", "a chill"]);
  });

  it("does not mutate the input body", () => {
    const body: SamplerBody = { banned_strings: ["x"] };
    withBannedStrings(body, ["y"]);
    expect(body.banned_strings).toEqual(["x"]);
  });
});

describe("buildSamplerSnapshot", () => {
  it("merges the draft and folds in the project bans", () => {
    const out = buildSamplerSnapshot({ temperature: 0.8 }, ["a chill"]);
    expect(out.temperature).toBe(0.8);
    expect(out.banned_strings).toEqual(["a chill"]);
  });

  it("adds no banned_strings when the project list is empty", () => {
    const out = buildSamplerSnapshot({ temperature: 0.8 }, []);
    expect(out.banned_strings).toBeUndefined();
  });
});

describe("clampMinTokens", () => {
  it("returns the body untouched when min_tokens is absent", () => {
    const body: SamplerBody = { temperature: 0.8 };
    expect(clampMinTokens(body, 1)).toBe(body);
  });

  it("returns the body untouched when min_tokens is within range", () => {
    const body: SamplerBody = { min_tokens: 4 };
    expect(clampMinTokens(body, 4)).toBe(body);
    expect(clampMinTokens(body, 8)).toBe(body);
  });

  it("lowers min_tokens to the max when it exceeds it, without mutating", () => {
    const body: SamplerBody = { min_tokens: 50, temperature: 0.7 };
    const out = clampMinTokens(body, 1);
    expect(out.min_tokens).toBe(1);
    expect(out.temperature).toBe(0.7);
    expect(body.min_tokens).toBe(50);
  });
});

describe("dropBannedOpenings", () => {
  it("returns every opening when there are no bans", () => {
    expect(dropBannedOpenings([" The", " A"], [])).toEqual([" The", " A"]);
  });

  it("drops an opening equal to a banned phrase, case-insensitively", () => {
    expect(dropBannedOpenings([" Suddenly", " The"], ["suddenly"])).toEqual([" The"]);
  });

  it("keeps an opening that merely contains a banned word", () => {
    expect(dropBannedOpenings([" There", " The"], ["the"])).toEqual([" There"]);
  });

  it("ignores empty ban entries", () => {
    expect(dropBannedOpenings([" The"], [""])).toEqual([" The"]);
  });
});

describe("runSeededFanOut", () => {
  function baseOpts() {
    return {
      resolvedMaxTokens: 5,
      signal: NEVER_ABORT,
      clearBranchPicker: noop,
      bannedStrings: [],
      beginSeeded: noop,
      setCandidates: noop,
      setError: noop,
    };
  }

  it("returns false and skips the fan-out when the probe yields no openings", async () => {
    let began = false;
    let streamed = 0;
    const ran = await runSeededFanOut({
      ...baseOpts(),
      fetchOpenings: async () => [],
      beginSeeded: () => {
        began = true;
      },
      streamSeed: async () => {
        streamed += 1;
      },
    });
    expect(ran).toBe(false);
    expect(began).toBe(false);
    expect(streamed).toBe(0);
  });

  it("drops a banned opening before seeding the rest", async () => {
    let beganWith: string[] | null = null;
    const seen: number[] = [];
    const ran = await runSeededFanOut({
      ...baseOpts(),
      bannedStrings: ["suddenly"],
      fetchOpenings: async () => [" Suddenly", " The", " A"],
      beginSeeded: (seeds) => {
        beganWith = seeds;
      },
      streamSeed: async (_seed, slot) => {
        seen.push(slot);
      },
    });
    expect(ran).toBe(true);
    expect(beganWith).toEqual([" The", " A"]);
    expect(seen.sort()).toEqual([0, 1]);
  });

  it("falls back to the plain path when every opening is banned", async () => {
    let began = false;
    const ran = await runSeededFanOut({
      ...baseOpts(),
      bannedStrings: ["the", "a"],
      fetchOpenings: async () => [" The", " A"],
      beginSeeded: () => {
        began = true;
      },
      streamSeed: async () => {},
    });
    expect(ran).toBe(false);
    expect(began).toBe(false);
  });

  it("fans out one continuation per opening, budgeted one below the branch max", async () => {
    const seen: { seed: string; slot: number; max: number }[] = [];
    let beganWith: string[] | null = null;
    const ran = await runSeededFanOut({
      ...baseOpts(),
      resolvedMaxTokens: 5,
      fetchOpenings: async () => [" A", " B", " C"],
      beginSeeded: (seeds) => {
        beganWith = seeds;
      },
      streamSeed: async (seed, slot, max) => {
        seen.push({ seed, slot, max });
      },
    });
    expect(ran).toBe(true);
    expect(beganWith).toEqual([" A", " B", " C"]);
    expect(seen.sort((a, b) => a.slot - b.slot)).toEqual([
      { seed: " A", slot: 0, max: 4 },
      { seed: " B", slot: 1, max: 4 },
      { seed: " C", slot: 2, max: 4 },
    ]);
  });

  it("seeds the slots but streams nothing when the budget is one token", async () => {
    let began = false;
    let streamed = 0;
    const ran = await runSeededFanOut({
      ...baseOpts(),
      resolvedMaxTokens: 1,
      fetchOpenings: async () => [" A", " B"],
      beginSeeded: () => {
        began = true;
      },
      streamSeed: async () => {
        streamed += 1;
      },
    });
    expect(ran).toBe(true);
    expect(began).toBe(true);
    expect(streamed).toBe(0);
  });

  it("re-raises an abort from the probe", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    await expect(
      runSeededFanOut({
        ...baseOpts(),
        fetchOpenings: async () => {
          throw abortErr;
        },
        streamSeed: async () => {},
      }),
    ).rejects.toBe(abortErr);
  });

  it("falls back to the plain path when the probe errors", async () => {
    let began = false;
    const ran = await runSeededFanOut({
      ...baseOpts(),
      fetchOpenings: async () => {
        throw new Error("backend 400");
      },
      beginSeeded: () => {
        began = true;
      },
      streamSeed: async () => {},
    });
    expect(ran).toBe(false);
    expect(began).toBe(false);
  });

  it("marks a failed continuation, surfaces its message, and leaves siblings", async () => {
    let current: Candidate[] = [
      { text: "a", done: false, finishReason: null },
      { text: "b", done: false, finishReason: null },
    ];
    let errorMsg: string | null = null;
    const ran = await runSeededFanOut({
      ...baseOpts(),
      fetchOpenings: async () => [" A", " B"],
      streamSeed: async (_seed, slot) => {
        if (slot === 0) throw new Error("boom");
      },
      setCandidates: (updater) => {
        current = updater(current);
      },
      setError: (m) => {
        errorMsg = m;
      },
    });
    expect(ran).toBe(true);
    expect(current[0]?.failed).toBe(true);
    expect(current[1]?.failed).toBeUndefined();
    expect(errorMsg).toBe("boom");
  });

  it("marks an aborted continuation done without surfacing an error", async () => {
    let current: Candidate[] = [{ text: "a", done: false, finishReason: null }];
    let errorMsg: string | null = null;
    const abortErr = Object.assign(new Error("stop"), { name: "AbortError" });
    await runSeededFanOut({
      ...baseOpts(),
      fetchOpenings: async () => [" A"],
      streamSeed: async () => {
        throw abortErr;
      },
      setCandidates: (updater) => {
        current = updater(current);
      },
      setError: (m) => {
        errorMsg = m;
      },
    });
    expect(current[0]?.done).toBe(true);
    expect(current[0]?.failed).toBeUndefined();
    expect(errorMsg).toBeNull();
  });
});
