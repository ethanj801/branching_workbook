import {
  streamChatCompletion,
  streamCompletion,
  type ChatCompletionRequestBody,
  type CompletionRequestBody,
  type SamplerBody,
} from "../api";
import { markCandidateDone, markCandidateFailed, type Candidate } from "../candidates";
import { mergePreset, neutralBody } from "../samplers/fields";

/**
 * The most branches a seeded ("Diverse openings") generation fans out at once.
 * Seeded mode sends one streaming request per branch instead of a single
 * batched n-sample request. Browsers open at most about six same-origin
 * HTTP/1.1 connections, so past that the later branches wait for an earlier one
 * to free a socket and stream in waves. Clamp the seeded branch count to that
 * ceiling so every branch streams at once. The plain n-sample path streams over
 * one connection and keeps the user's full count.
 */
export const SEEDED_BRANCH_CAP = 6;

/**
 * How many first-token candidates the probe requests. Seeds are sampled from
 * this pool rather than taken as its head, so the pool needs enough candidates
 * beyond SEEDED_BRANCH_CAP that sampling can differ from a plain top-k cut,
 * with headroom left for ban filtering. A token outside the pool can never
 * become a seed, but tokens this deep carry near-zero probability and would
 * almost never be drawn anyway. The backends
 * we target accept any top_logprobs count, the exllamav3 generator sorts the
 * full vocabulary regardless of k, and the pool rides in a single one-token
 * response, so a generous pool is effectively free. A strictly OpenAI
 * compatible server would reject anything above 20, and the caller already
 * falls back to the plain n-sample path when the probe errors.
 */
export const SEEDED_POOL_SIZE = 128;

/** One candidate opening from the probe, with the probe's returned logprob. */
export type Opening = { token: string; logprob: number };

/**
 * Order a completion-endpoint top_logprobs map (token string to logprob) from
 * most to least likely. The completion endpoint returns each position as a
 * flat map.
 */
export function rankCompletionTop(
  top: Record<string, number> | null | undefined,
): Opening[] {
  if (!top) return [];
  return Object.entries(top)
    .sort((a, b) => b[1] - a[1])
    .map(([token, logprob]) => ({ token, logprob }));
}

/**
 * Order a chat-endpoint top_logprobs list from most to least likely. The chat
 * endpoint returns each position as a ranked list of `{ token, logprob }`.
 */
export function rankChatTop(
  top: { token: string; logprob: number }[] | null | undefined,
): Opening[] {
  if (!top) return [];
  return [...top]
    .sort((a, b) => b.logprob - a.logprob)
    .map((leaf) => ({ token: leaf.token, logprob: leaf.logprob }));
}

/**
 * Add the project ban list to a request body's banned_strings, merging into any
 * already present rather than overwriting. Dedupe is case-insensitive because
 * TabbyAPI lowercases banned strings before matching.
 */
export function withBannedStrings(body: SamplerBody, extra: string[]): SamplerBody {
  if (extra.length === 0) return body;
  const existing = body.banned_strings ?? [];
  const seen = new Set(existing.map((s) => s.toLowerCase()));
  const merged = [...existing];
  for (const phrase of extra) {
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(phrase);
  }
  return { ...body, banned_strings: merged };
}

/**
 * Build the sampler body for a generation request. Merge the active preset over
 * the draft, then fold in the project ban list so every generation entry point
 * carries the bans through one call. The prose and chat paths also persist this
 * as the node's sampler snapshot, so the request body and the recorded snapshot
 * stay the same value.
 */
export function buildSamplerSnapshot(
  draftBody: SamplerBody,
  activeBannedStrings: string[],
): SamplerBody {
  return withBannedStrings(mergePreset(draftBody), activeBannedStrings);
}

/**
 * Remove pool candidates that are themselves a banned phrase. The probe reads
 * the raw model distribution, which the ban list does not constrain, so a
 * banned token can sit high in the pool. A seed goes into the prompt verbatim,
 * so a seed equal to a banned phrase would open the branch with banned text.
 * Filtering the pool before sampling means a banned candidate never consumes a
 * seed slot. Matching is exact on the trimmed lowercased text, so banning a
 * common word does not also drop the many openings that merely contain it.
 * Later continuation tokens stay suppressed by banned_strings.
 */
export function dropBannedOpenings(openings: Opening[], banned: string[]): Opening[] {
  const needles = new Set(
    banned.map((b) => b.toLowerCase().trim()).filter((b) => b.length > 0),
  );
  if (needles.size === 0) return openings;
  return openings.filter((opening) => !needles.has(opening.token.toLowerCase().trim()));
}

/** Numerically stable log(exp(a) + exp(b)), for merging duplicate tokens. */
function logAddExp(a: number, b: number): number {
  const m = Math.max(a, b);
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}

/**
 * Merge pool candidates that decode to the same token string, summing their
 * probability mass, and return them most likely first. Two byte-distinct token
 * ids that share a string would otherwise seed two identical branches.
 */
export function mergeOpenings(pool: Opening[]): Opening[] {
  const mergedMass = new Map<string, number>();
  for (const opening of pool) {
    const prev = mergedMass.get(opening.token);
    mergedMass.set(
      opening.token,
      prev === undefined ? opening.logprob : logAddExp(prev, opening.logprob),
    );
  }
  return [...mergedMass]
    .map(([token, logprob]) => ({ token, logprob }))
    .sort((a, b) => b.logprob - a.logprob);
}

/**
 * Draw up to `count` distinct seeds from the probed pool.
 *
 * mergeOpenings collapses duplicate token strings first, then the draw is the
 * Gumbel top-k trick at temperature one. Add independent Gumbel noise to each
 * merged log weight and keep the `count` largest keys. That is sampling without
 * replacement from the pool's own distribution, the same as repeatedly drawing
 * one seed, removing it, and rescaling the rest. The probe already removed the
 * end token and the truncation samplers, so the draw runs over the full
 * distribution and its diversity comes from the without-replacement draw alone.
 * A pool smaller than `count` yields every candidate.
 */
export function sampleOpenings(
  pool: Opening[],
  count: number,
  rng: () => number = Math.random,
): string[] {
  const survivors = mergeOpenings(pool);
  if (survivors.length === 0 || count <= 0) return [];
  const keyed = survivors.map((s) => {
    // Math.random can return exactly zero, which would make the Gumbel term
    // infinite. Clamp to the smallest positive double.
    const u = rng() || Number.MIN_VALUE;
    return { token: s.token, key: s.logprob - Math.log(-Math.log(u)) };
  });
  keyed.sort((a, b) => b.key - a.key);
  return keyed.slice(0, count).map((entry) => entry.token);
}

/**
 * Split `count` branch slots across the pool candidates when there are fewer of
 * them than slots. Every candidate keeps at least one slot, and the extras go
 * out proportionally to probability mass, by largest remainder. A candidate
 * holding more than one slot gets split at the next token position by growSeeds.
 */
export function allocateSeedSlots(survivors: Opening[], count: number): number[] {
  const peak = survivors[0]?.logprob ?? 0;
  const weights = survivors.map((s) => Math.exp(s.logprob - peak));
  const mass = weights.reduce((total, w) => total + w, 0);
  const extra = count - survivors.length;
  const quotas = weights.map((w) => (extra * w) / mass);
  const slots = quotas.map((q) => 1 + Math.floor(q));
  let left = count - slots.reduce((total, s) => total + s, 0);
  const byRemainder = quotas
    .map((q, i) => ({ i, frac: q - Math.floor(q) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of byRemainder) {
    if (left <= 0) break;
    slots[i] = (slots[i] ?? 1) + 1;
    left -= 1;
  }
  return slots;
}

/** One seed for a branch. The text holds `tokenCount` preselected tokens. */
export type Seed = { text: string; tokenCount: number };

/**
 * How many tokens deep a seed may grow while hunting for enough distinct
 * openings. Each level costs one extra one-token probe per split prefix, and a
 * heavily truncated distribution such as top_k 1 never widens, so the hunt
 * needs a cutoff. Past this depth the branch count is allowed to fall short.
 */
export const SEED_DEPTH_CAP = 8;

export type GrowSeedsArgs = {
  /** Text of the tokens already fixed for this subtree. Empty at the root. */
  prefix: string;
  /** How many tokens are in the prefix. */
  depth: number;
  /** The probed next-token pool after the prefix. */
  pool: Opening[];
  /** How many branch slots this subtree should fill. */
  count: number;
  /** Active project bans. A pool candidate that is itself banned never seeds. */
  bannedStrings: string[];
  /** Depth at which growth stops and the branch count may fall short. */
  maxDepth: number;
  /** Probe the next-token pool after the given prefix text. */
  probe: (prefixText: string) => Promise<Opening[]>;
  /** Uniform RNG for the seed draws. Tests inject a fixed sequence. */
  rng?: () => number;
};

/**
 * Grow up to `count` distinct seeds from the probed pool, going deeper when
 * one position cannot supply enough options.
 *
 * When the merged pool holds at least `count` candidates this is a plain
 * one-token draw. When it holds fewer, every candidate becomes a prefix, the
 * missing slots are split across them by probability mass, and each prefix
 * owing more than one branch is probed one token further and grown recursively.
 * A split prefix never stays as a branch of its own, its slots are always
 * filled by its extensions, so the finished seeds are pairwise distinct at
 * their first diverging token. A prefix whose deeper pool comes back empty or
 * unreachable falls back to being a single bare seed. The recursion stops at
 * maxDepth and returns fewer seeds when the distribution never widens. An abort
 * during a deeper probe re-raises so Stop stays silent.
 */
export async function growSeeds(args: GrowSeedsArgs): Promise<Seed[]> {
  const filtered = dropBannedOpenings(args.pool, args.bannedStrings);
  const survivors = mergeOpenings(filtered);
  if (survivors.length === 0 || args.count <= 0) return [];
  const nextDepth = args.depth + 1;
  if (survivors.length >= args.count || nextDepth >= args.maxDepth) {
    return sampleOpenings(filtered, args.count, args.rng).map(
      (token) => ({ text: args.prefix + token, tokenCount: nextDepth }),
    );
  }

  const slots = allocateSeedSlots(survivors, args.count);
  const grown = await Promise.all(
    survivors.map(async (survivor, i): Promise<Seed[]> => {
      const text = args.prefix + survivor.token;
      const bare: Seed[] = [{ text, tokenCount: nextDepth }];
      const share = slots[i] ?? 1;
      if (share <= 1) return bare;
      let deeperPool: Opening[];
      try {
        deeperPool = await args.probe(text);
      } catch (err) {
        if ((err as Error).name === "AbortError") throw err;
        return bare;
      }
      const deeper = await growSeeds({
        ...args,
        prefix: text,
        depth: nextDepth,
        pool: deeperPool,
        count: share,
      });
      return deeper.length > 0 ? deeper : bare;
    }),
  );
  return grown.flat();
}

/**
 * Lower min_tokens so it never exceeds max_tokens. Seeding spends the first
 * token on the preselected seed, so a continuation's budget is one below the
 * branch budget, and the opening probe runs with max_tokens 1. A min_tokens the
 * user set against the full budget can land above either request's max, and
 * TabbyAPI rejects a request whose min_tokens exceeds its max_tokens. A body
 * with no min_tokens, or one already within range, is returned untouched.
 */
export function clampMinTokens<T extends { min_tokens?: number }>(
  body: T,
  maxTokens: number,
): T {
  const min = body.min_tokens;
  if (min == null || min <= maxTokens) return body;
  return { ...body, min_tokens: maxTokens };
}

/**
 * The sampler the opening probe sends, fixed and independent of the user's
 * settings. Every truncation and temperature sits at its neutral no-op, so the
 * probe reads the model's true next-token distribution, and post_sampling_probs
 * with ban_eos_token removes the end token from it by id. Diversity comes from
 * the without-replacement draw over this full distribution, so the user's
 * truncation never narrows the pool. The neutral values are sent explicitly so
 * no preset or server-side default reshapes the probe.
 */
export function neutralProbeSampler(): SamplerBody {
  return { ...neutralBody(), ban_eos_token: true, post_sampling_probs: true };
}

/**
 * Run a one-token completion that returns the first token's distribution, then
 * return the candidate openings with their logprobs, most likely first (up to
 * `k`, which defaults to the seeded pool size). The probe returns `k` of them
 * whenever the backend reports logprobs at all. An empty result means it
 * reported none, and the caller falls back to a plain n-sample generation.
 */
export async function fetchProseOpenings(
  body: Omit<CompletionRequestBody, "n" | "max_tokens" | "logprobs" | "top_logprobs">,
  signal: AbortSignal,
  k: number = SEEDED_POOL_SIZE,
): Promise<Opening[]> {
  // Request the same count on both fields. The exllamav3 backend drives the
  // returned candidate count from top_logprobs. The exllamav2 backend drives it
  // from logprobs. Setting one alone collapses the openings to a single token on
  // the other backend. logprobs > 0 also gates per-token logprob collection.
  let ranked: Opening[] = [];
  await streamCompletion(
    {
      ...clampMinTokens(body, 1),
      n: 1,
      max_tokens: 1,
      logprobs: k,
      top_logprobs: k,
    },
    (chunk) => {
      if (ranked.length) return;
      const top = chunk.choices[0]?.logprobs?.top_logprobs?.[0];
      const r = rankCompletionTop(top);
      if (r.length) ranked = r;
    },
    signal,
  );
  return ranked.slice(0, k);
}

/** The chat-endpoint counterpart to fetchProseOpenings. */
export async function fetchChatOpenings(
  body: Omit<
    ChatCompletionRequestBody,
    "n" | "max_tokens" | "logprobs" | "top_logprobs"
  >,
  signal: AbortSignal,
  k: number = SEEDED_POOL_SIZE,
): Promise<Opening[]> {
  let ranked: Opening[] = [];
  await streamChatCompletion(
    {
      ...clampMinTokens(body, 1),
      n: 1,
      max_tokens: 1,
      logprobs: k,
      top_logprobs: k,
    },
    (chunk) => {
      if (ranked.length) return;
      const top = chunk.choices[0]?.logprobs?.content?.[0]?.top_logprobs;
      const r = rankChatTop(top);
      if (r.length) ranked = r;
    },
    signal,
  );
  return ranked.slice(0, k);
}

export type SeededFanOut = {
  /** Per-branch token budget. The seed is the branch's first token. */
  resolvedMaxTokens: number;
  /** Shared signal so Stop cancels the probe and every continuation. */
  signal: AbortSignal;
  /**
   * Drop any prior picker before the probe await. If the probe fails, control
   * returns to the caller without a new generation, and a leftover picker would
   * let Use/Keep act on candidates from an earlier prompt.
   */
  clearBranchPicker: () => void;
  /**
   * Run a one-token probe after `prefixText` and return the candidate pool,
   * most likely first. An empty prefix probes the opening position. Deeper
   * prefixes carry the seed text grown so far.
   */
  fetchOpenings: (signal: AbortSignal, prefixText: string) => Promise<Opening[]>;
  /** Active project bans. A pool candidate that is itself banned never seeds. */
  bannedStrings: string[];
  /** How many seeds to draw from the pool. */
  seedCount: number;
  /** Uniform RNG for the seed draw. Tests inject a fixed sequence. */
  rng?: () => number;
  /** Open the picker for the seeded slots: startGeneration plus seededCandidates. */
  beginSeeded: (seeds: string[]) => void;
  /** Stream one continuation for `seed` into `slot`, bounded by `continuationMax`. */
  streamSeed: (
    seed: string,
    slot: number,
    continuationMax: number,
    signal: AbortSignal,
  ) => Promise<void>;
  /** The candidate-state setter, so the helper can mark a slot done or failed. */
  setCandidates: (updater: (current: Candidate[]) => Candidate[]) => void;
  /** Surface the first real (non-abort) continuation error. */
  setError: (message: string) => void;
};

/**
 * Run the seeded ("Diverse openings") fan-out shared by prose and chat. Probe
 * the first token's distribution, grow one opening per branch from the pool,
 * probing deeper positions when one position cannot supply enough distinct
 * options, then fan out one continuation per opening so siblings start
 * differently. Returns true when it drove a seeded generation, and false when
 * the probe returned no usable pool so the caller should run its plain
 * n-sample path. An abort during any probe re-raises so Stop stays silent.
 */
export async function runSeededFanOut(opts: SeededFanOut): Promise<boolean> {
  opts.clearBranchPicker();
  let pool: Opening[];
  try {
    pool = await opts.fetchOpenings(opts.signal, "");
  } catch (err) {
    // A backend that rejects the logprobs probe shouldn't leave the user with
    // no branches. Re-raise an abort so Stop stays silent. Otherwise fall back
    // to the plain n-sample path by reporting an empty pool.
    if ((err as Error).name === "AbortError") throw err;
    pool = [];
  }

  // Grow one seed per branch from the pool. An empty result means the backend
  // reported no logprobs or every candidate was banned, so fall back to the
  // plain n-sample path. A seed never grows past the branch token budget.
  const seeds = await growSeeds({
    prefix: "",
    depth: 0,
    pool,
    count: opts.seedCount,
    bannedStrings: opts.bannedStrings,
    maxDepth: Math.max(1, Math.min(SEED_DEPTH_CAP, opts.resolvedMaxTokens)),
    probe: (prefixText) => opts.fetchOpenings(opts.signal, prefixText),
    rng: opts.rng,
  });
  if (seeds.length === 0) return false;

  opts.beginSeeded(seeds.map((seed) => seed.text));
  // Hold the first real error in a box so the post-await read sees the
  // assignment made inside the .catch callbacks. A plain let stays narrowed to
  // its initializer across the closure boundary.
  const failure: { error: Error | null } = { error: null };
  // One stream per opening replaces the single batched n-sample request. The
  // seeded branch count is clamped to SEEDED_BRANCH_CAP at the call site, which
  // is the browser's same-origin connection limit, so the concurrent streams
  // stay within what the browser will open at once. The model's max_batch_size
  // is a separate backend limit on batch occupancy that these separate requests
  // still draw from. The extra requests buy the distinct openings that are the
  // point of this mode.
  await Promise.all(
    seeds.map((seed, slot) => {
      // The seed tokens count against the token budget, so the continuation
      // gets what remains. If the seed alone exhausts the budget the branch
      // is just the seed.
      const continuationMax = opts.resolvedMaxTokens - seed.tokenCount;
      if (continuationMax <= 0) return Promise.resolve();
      return opts
        .streamSeed(seed.text, slot, continuationMax, opts.signal)
        .catch((err: unknown) => {
          const e = err as Error;
          if (e.name === "AbortError") {
            // Stop keeps the slot's partial text without flagging failure.
            opts.setCandidates((current) => markCandidateDone(current, slot));
            return;
          }
          // A real failure marks the slot failed so the picker disables it, and
          // is surfaced once below. The others keep streaming.
          if (!failure.error) failure.error = e;
          opts.setCandidates((current) => markCandidateFailed(current, slot));
        });
    }),
  );
  if (failure.error) opts.setError(failure.error.message);
  return true;
}
