import { describe, it, expect } from "vitest";
import {
  allocateSeedSlots,
  buildSamplerSnapshot,
  clampMinTokens,
  dropBannedOpenings,
  growSeeds,
  mergeOpenings,
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

describe("allocateSeedSlots", () => {
  it("gives every survivor a slot and sums to the count", () => {
    const slots = allocateSeedSlots(pool(" A", " B", " C"), 6);
    expect(slots).toHaveLength(3);
    expect(slots.reduce((a, b) => a + b, 0)).toBe(6);
    expect(Math.min(...slots)).toBeGreaterThanOrEqual(1);
  });

  it("weights the extra slots toward the likelier survivor", () => {
    const survivors: Opening[] = [
      { token: " A", logprob: Math.log(0.8) },
      { token: " B", logprob: Math.log(0.2) },
    ];
    expect(allocateSeedSlots(survivors, 6)).toEqual([4, 2]);
  });
});

describe("mergeOpenings", () => {
  it("sums the mass of candidates that share a token string", () => {
    const merged = mergeOpenings([
      { token: " A", logprob: Math.log(0.4) },
      { token: " The", logprob: Math.log(0.3) },
      { token: " The", logprob: Math.log(0.3) },
    ]);
    // " The" merges to 0.6 and outranks " A" at 0.4.
    expect(merged.map((o) => o.token)).toEqual([" The", " A"]);
    expect(merged.map((o) => Math.exp(o.logprob))).toEqual([
      expect.closeTo(0.6),
      expect.closeTo(0.4),
    ]);
  });
});

describe("sampleOpenings", () => {
  it("draws every opening exactly once when asked for the whole pool", () => {
    const tokens = [" The", " It", " A", " He"];
    const out = sampleOpenings(pool(...tokens), 4);
    expect([...out].sort()).toEqual([...tokens].sort());
  });

  it("orders by likelihood under a constant rng", () => {
    // Identical noise on every candidate shifts all keys by the same amount,
    // so the draw reduces to the likelihood order.
    const out = sampleOpenings(pool(" The", " It", " A"), 2, () => 0.5);
    expect(out).toEqual([" The", " It"]);
  });

  it("can draw an unlikely opening when the noise favors it", () => {
    const candidates: Opening[] = [
      { token: " A", logprob: Math.log(0.9) },
      { token: " B", logprob: Math.log(0.1) },
    ];
    const out = sampleOpenings(candidates, 1, sequenceRng([0.0001, 0.999]));
    expect(out).toEqual([" B"]);
  });

  it("merges candidates that share a token string before drawing", () => {
    // First-wins dedupe would leave " The" at 0.3 and pick " A". Merged mass
    // makes " The" 0.6, so it wins the likelihood-ordered draw, and the pool
    // holds two distinct openings.
    const candidates: Opening[] = [
      { token: " A", logprob: Math.log(0.4) },
      { token: " The", logprob: Math.log(0.3) },
      { token: " The", logprob: Math.log(0.3) },
    ];
    expect(sampleOpenings(candidates, 1, () => 0.5)).toEqual([" The"]);
    expect(sampleOpenings(candidates, 3)).toHaveLength(2);
  });

  it("returns nothing for an empty pool or a zero count", () => {
    expect(sampleOpenings([], 3)).toEqual([]);
    expect(sampleOpenings(pool(" The"), 0)).toEqual([]);
  });
});

describe("growSeeds", () => {
  function baseArgs() {
    return {
      prefix: "",
      depth: 0,
      count: 3,
      // A constant rng gives every candidate the same Gumbel term, so the draw
      // falls back to likelihood order and tests can assert exact seed sets.
      rng: () => 0.5,
      bannedStrings: [],
      maxDepth: 8,
      probe: async (): Promise<Opening[]> => {
        throw new Error("no probe expected");
      },
    };
  }

  it("stays a one-token draw when the pool covers the count", async () => {
    const seeds = await growSeeds({ ...baseArgs(), pool: pool(" A", " B", " C") });
    expect(seeds).toEqual([
      { text: " A", tokenCount: 1 },
      { text: " B", tokenCount: 1 },
      { text: " C", tokenCount: 1 },
    ]);
  });

  it("splits a short pool at the second token and keeps no bare split prefix", async () => {
    const probed: string[] = [];
    const seeds = await growSeeds({
      ...baseArgs(),
      pool: pool(" A", " B"),
      probe: async (prefixText) => {
        probed.push(prefixText);
        return pool(" x", " y");
      },
    });
    // Two survivors take three slots, so the likelier prefix owes two branches
    // and gets split. Its extensions replace it. The other stays bare.
    expect(probed).toEqual([" A"]);
    expect(seeds).toEqual([
      { text: " A x", tokenCount: 2 },
      { text: " A y", tokenCount: 2 },
      { text: " B", tokenCount: 1 },
    ]);
  });

  it("keeps growing when the second position is also short", async () => {
    const probed: string[] = [];
    const seeds = await growSeeds({
      ...baseArgs(),
      maxDepth: 3,
      pool: pool(" A"),
      probe: async (prefixText) => {
        probed.push(prefixText);
        return pool(" z");
      },
    });
    // Every position offers one option, so growth walks to maxDepth and then
    // settles for a single seed.
    expect(probed).toEqual([" A", " A z"]);
    expect(seeds).toEqual([{ text: " A z z", tokenCount: 3 }]);
  });

  it("returns the short draw when maxDepth forbids growing", async () => {
    const seeds = await growSeeds({ ...baseArgs(), maxDepth: 1, pool: pool(" A", " B") });
    expect(seeds).toEqual([
      { text: " A", tokenCount: 1 },
      { text: " B", tokenCount: 1 },
    ]);
  });

  it("filters bans from a deeper pool", async () => {
    const seeds = await growSeeds({
      ...baseArgs(),
      bannedStrings: ["bad"],
      pool: pool(" A", " B"),
      probe: async () => pool(" bad", " x", " y"),
    });
    expect(seeds).toEqual([
      { text: " A x", tokenCount: 2 },
      { text: " A y", tokenCount: 2 },
      { text: " B", tokenCount: 1 },
    ]);
  });

  it("falls back to the bare prefix when its deeper probe fails", async () => {
    const seeds = await growSeeds({
      ...baseArgs(),
      pool: pool(" A", " B"),
      probe: async () => {
        throw new Error("backend 400");
      },
    });
    expect(seeds).toEqual([
      { text: " A", tokenCount: 1 },
      { text: " B", tokenCount: 1 },
    ]);
  });

  it("falls back to the bare prefix when its deeper pool filters to nothing", async () => {
    const seeds = await growSeeds({
      ...baseArgs(),
      bannedStrings: ["bad"],
      pool: pool(" A", " B"),
      probe: async () => pool(" bad"),
    });
    expect(seeds).toEqual([
      { text: " A", tokenCount: 1 },
      { text: " B", tokenCount: 1 },
    ]);
  });

  it("re-raises an abort from a deeper probe", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    await expect(
      growSeeds({
        ...baseArgs(),
        pool: pool(" A", " B"),
        probe: async () => {
          throw abortErr;
        },
      }),
    ).rejects.toBe(abortErr);
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
      // A constant rng gives every candidate the same Gumbel term, so the draw
      // falls back to likelihood order and tests can assert exact seed sets.
      rng: () => 0.5,
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
      seedCount: 2,
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

  it("grows past a short pool and budgets each branch below its seed length", async () => {
    const seen: { seed: string; max: number }[] = [];
    let beganWith: string[] | null = null;
    const ran = await runSeededFanOut({
      ...baseOpts(),
      resolvedMaxTokens: 5,
      fetchOpenings: async (_signal, prefixText) =>
        prefixText === "" ? pool(" A", " B") : pool(" x", " y"),
      beginSeeded: (seeds) => {
        beganWith = seeds;
      },
      streamSeed: async (seed, _slot, max) => {
        seen.push({ seed, max });
      },
    });
    expect(ran).toBe(true);
    expect(beganWith).toEqual([" A x", " A y", " B"]);
    expect(seen.sort((a, b) => a.seed.localeCompare(b.seed))).toEqual([
      { seed: " A x", max: 3 },
      { seed: " A y", max: 3 },
      { seed: " B", max: 4 },
    ]);
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
