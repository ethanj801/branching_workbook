import { describe, it, expect } from "vitest";
import {
  buildSamplerSnapshot,
  clampMinTokens,
  dropBannedOpenings,
  rankChatTop,
  rankCompletionTop,
  runSeededFanOut,
  sampleOpenings,
  withBannedStrings,
  type Opening,
} from "./seeding";
import type { SamplerBody } from "../api";
import type { Candidate } from "../candidates";

const NEVER_ABORT = new AbortController().signal;
const noop = () => {};

/** Build a pool from tokens, most likely first, with descending logprobs. */
function pool(...tokens: string[]): Opening[] {
  return tokens.map((token, i) => ({ token, logprob: -0.5 * (i + 1) }));
}

/** An rng that replays a fixed sequence, for deterministic draws. */
function sequenceRng(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length] ?? 0.5;
}

describe("rankCompletionTop", () => {
  it("orders a token-to-logprob map from most to least likely", () => {
    const ranked = rankCompletionTop({ " A": -2.1, " The": -0.3, " It": -1.4 });
    expect(ranked).toEqual([
      { token: " The", logprob: -0.3 },
      { token: " It", logprob: -1.4 },
      { token: " A", logprob: -2.1 },
    ]);
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
    expect(ranked).toEqual([
      { token: " The", logprob: -0.3 },
      { token: " It", logprob: -1.4 },
      { token: " A", logprob: -2.1 },
    ]);
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
    expect(dropBannedOpenings(pool(" The", " A"), [])).toEqual(pool(" The", " A"));
  });

  it("drops an opening equal to a banned phrase, case-insensitively", () => {
    const out = dropBannedOpenings(pool(" Suddenly", " The"), ["suddenly"]);
    expect(out.map((o) => o.token)).toEqual([" The"]);
  });

  it("keeps an opening that merely contains a banned word", () => {
    const out = dropBannedOpenings(pool(" There", " The"), ["the"]);
    expect(out.map((o) => o.token)).toEqual([" There"]);
  });

  it("ignores empty ban entries", () => {
    expect(dropBannedOpenings(pool(" The"), [""])).toEqual(pool(" The"));
  });
});

describe("sampleOpenings", () => {
  it("returns the most likely openings in order at temperature zero", () => {
    const out = sampleOpenings(pool(" The", " It", " A", " He"), 2, {
      temperature: 0,
    });
    expect(out).toEqual([" The", " It"]);
  });

  it("draws every opening exactly once when asked for the whole pool", () => {
    const tokens = [" The", " It", " A", " He"];
    const out = sampleOpenings(pool(...tokens), 4, { temperature: 1 });
    expect([...out].sort()).toEqual([...tokens].sort());
  });

  it("orders by likelihood under a constant rng", () => {
    // Identical noise on every candidate shifts all keys by the same amount,
    // so the draw reduces to the likelihood order.
    const out = sampleOpenings(pool(" The", " It", " A"), 2, {}, () => 0.5);
    expect(out).toEqual([" The", " It"]);
  });

  it("can draw an unlikely opening when the noise favors it", () => {
    const candidates: Opening[] = [
      { token: " A", logprob: Math.log(0.9) },
      { token: " B", logprob: Math.log(0.1) },
    ];
    const out = sampleOpenings(candidates, 1, {}, sequenceRng([0.0001, 0.999]));
    expect(out).toEqual([" B"]);
  });

  it("limits eligible openings to top_k", () => {
    const out = sampleOpenings(pool(" The", " It", " A", " He"), 4, { top_k: 2 });
    expect(out).toHaveLength(2);
    expect([...out].sort()).toEqual([" It", " The"]);
  });

  it("drops candidates far below the peak with min_p", () => {
    const candidates: Opening[] = [
      { token: " The", logprob: Math.log(0.5) },
      { token: " It", logprob: Math.log(0.4) },
      { token: " A", logprob: Math.log(0.001) },
    ];
    const out = sampleOpenings(candidates, 3, { min_p: 0.5 });
    expect(out).toHaveLength(2);
    expect(out).not.toContain(" A");
  });

  it("keeps only tokens whose cumulative raw mass stays within top_p", () => {
    // The engine drops the token that crosses the top_p boundary, keeping the
    // most likely token unconditionally.
    const candidates: Opening[] = [
      { token: " The", logprob: Math.log(0.6) },
      { token: " It", logprob: Math.log(0.3) },
      { token: " A", logprob: Math.log(0.1) },
    ];
    expect(sampleOpenings(candidates, 3, { top_p: 0.7 })).toEqual([" The"]);
  });

  it("keeps the whole pool when its raw mass never reaches top_p", () => {
    // The pool holds 0.6 of the true mass, so the real nucleus extends past
    // it and every returned candidate is inside. Normalizing within the pool
    // would wrongly cut at 0.9 of the pool.
    const candidates: Opening[] = [
      { token: " The", logprob: Math.log(0.3) },
      { token: " It", logprob: Math.log(0.2) },
      { token: " A", logprob: Math.log(0.1) },
    ];
    expect(sampleOpenings(candidates, 3, { top_p: 0.9 })).toHaveLength(3);
  });

  it("cuts top_p against the top_k survivors when top_k lands in the pool", () => {
    // The engine renormalizes after top_k. The same pool and top_p that stay
    // intact above now cut down to one token, because the two top_k survivors
    // become the whole mass base and the second one crosses 0.9.
    const candidates: Opening[] = [
      { token: " The", logprob: Math.log(0.3) },
      { token: " It", logprob: Math.log(0.2) },
      { token: " A", logprob: Math.log(0.1) },
    ];
    expect(sampleOpenings(candidates, 3, { top_k: 2, top_p: 0.9 })).toEqual([" The"]);
  });

  it("applies temperature before truncation unless temperature_last is set", () => {
    // At temperature 5 the ratios flatten, so every candidate clears a 0.5
    // min_p bar. With temperature_last the bar applies to the raw ratios and
    // the weakest candidate falls below it.
    const candidates: Opening[] = [
      { token: " The", logprob: Math.log(0.5) },
      { token: " It", logprob: Math.log(0.3) },
      { token: " A", logprob: Math.log(0.2) },
    ];
    const tempFirst = sampleOpenings(candidates, 3, { temperature: 5, min_p: 0.5 });
    expect(tempFirst).toHaveLength(3);
    const tempLast = sampleOpenings(candidates, 3, {
      temperature: 5,
      min_p: 0.5,
      temperature_last: true,
    });
    expect(tempLast).toHaveLength(2);
    expect(tempLast).not.toContain(" A");
  });

  it("merges candidates that share a token string, summing their mass", () => {
    // First-wins dedupe would leave " The" at 0.3 and pick " A". Merged mass
    // makes " The" 0.6 and it wins the greedy draw.
    const candidates: Opening[] = [
      { token: " A", logprob: Math.log(0.4) },
      { token: " The", logprob: Math.log(0.3) },
      { token: " The", logprob: Math.log(0.3) },
    ];
    expect(sampleOpenings(candidates, 1, { temperature: 0 })).toEqual([" The"]);
    expect(sampleOpenings(candidates, 3, {})).toHaveLength(2);
  });

  it("returns nothing for an empty pool or a zero count", () => {
    expect(sampleOpenings([], 3, {})).toEqual([]);
    expect(sampleOpenings(pool(" The"), 0, {})).toEqual([]);
  });
});

describe("runSeededFanOut", () => {
  function baseOpts() {
    return {
      resolvedMaxTokens: 5,
      signal: NEVER_ABORT,
      clearBranchPicker: noop,
      bannedStrings: [],
      seedCount: 3,
      // Temperature zero makes the draw deterministic, so tests can assert
      // exact seed sets.
      samplerBody: { temperature: 0 } as SamplerBody,
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
      fetchOpenings: async () => pool(" Suddenly", " The", " A"),
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

  it("keeps the full seed count when a banned candidate sits in the pool", async () => {
    let beganWith: string[] | null = null;
    const ran = await runSeededFanOut({
      ...baseOpts(),
      bannedStrings: ["suddenly"],
      fetchOpenings: async () => pool(" Suddenly", " The", " A", " It"),
      beginSeeded: (seeds) => {
        beganWith = seeds;
      },
      streamSeed: async () => {},
    });
    expect(ran).toBe(true);
    expect(beganWith).toEqual([" The", " A", " It"]);
  });

  it("falls back to the plain path when every opening is banned", async () => {
    let began = false;
    const ran = await runSeededFanOut({
      ...baseOpts(),
      bannedStrings: ["the", "a"],
      fetchOpenings: async () => pool(" The", " A"),
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
      fetchOpenings: async () => pool(" A", " B", " C"),
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

  it("seeds no more branches than the seed count from a larger pool", async () => {
    let beganWith: string[] | null = null;
    await runSeededFanOut({
      ...baseOpts(),
      seedCount: 2,
      fetchOpenings: async () => pool(" A", " B", " C", " D", " E"),
      beginSeeded: (seeds) => {
        beganWith = seeds;
      },
      streamSeed: async () => {},
    });
    expect(beganWith).toEqual([" A", " B"]);
  });

  it("seeds the slots but streams nothing when the budget is one token", async () => {
    let began = false;
    let streamed = 0;
    const ran = await runSeededFanOut({
      ...baseOpts(),
      resolvedMaxTokens: 1,
      fetchOpenings: async () => pool(" A", " B"),
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
      seedCount: 2,
      fetchOpenings: async () => pool(" A", " B"),
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
      seedCount: 1,
      fetchOpenings: async () => pool(" A"),
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
