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
 * with headroom left for ban filtering and the truncation samplers. A token
 * outside the pool can never become a seed, but tokens this deep carry
 * near-zero probability and would almost never be drawn anyway. The backends
 * we target accept any top_logprobs count, the exllamav3 generator sorts the
 * full vocabulary regardless of k, and the pool rides in a single one-token
 * response, so a generous pool is effectively free. A strictly OpenAI
 * compatible server would reject anything above 20, and the caller already
 * falls back to the plain n-sample path when the probe errors.
 */
export const SEEDED_POOL_SIZE = 128;

/** One candidate opening from the probe. The logprob is the raw model value. */
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

// sanitizeSamplerBody strips fields sitting at their neutral no-op values, so
// an absent key means the field is neutral. Resolve absent keys from the field
// catalog instead of restating the neutral values here.
const NEUTRALS = neutralBody();

function resolveNumber(value: number | undefined, neutral: unknown): number {
  if (value !== undefined) return value;
  return typeof neutral === "number" ? neutral : 0;
}

/**
 * Draw up to `count` distinct seeds from the probed pool.
 *
 * The pool logprobs are first reshaped by the sampler settings that are pure
 * functions of a single position's distribution, in the order TabbyAPI's
 * exllamav3 sampler builder applies them. Temperature rescales the weights,
 * then top_k, top_p, and min_p truncate them. temperature_last defers the
 * rescale until after the truncations, which then see the unscaled
 * distribution. Samplers that need information the probe cannot carry shape
 * only the continuations. Dynamic temperature, typical, and tfs need
 * full-vocabulary statistics, DRY and the repetition penalties need the
 * prompt, and mirostat needs cross-step state. XTC has a per-position closed
 * form but is left out to keep the replicated set small and unambiguous.
 *
 * The draw itself is the Gumbel top-k trick. Add independent Gumbel noise to
 * each surviving log weight and keep the `count` largest keys. That is exactly
 * the sampling-without-replacement distribution, the same as repeatedly
 * drawing one seed, removing it, and rescaling the rest. A temperature of zero
 * degenerates to the deterministic top `count`, matching greedy decoding.
 *
 * Candidates that decode to the same token string are merged up front with
 * their probability mass summed, so two byte-distinct tokens cannot yield two
 * identical branches. Truncation can leave fewer than `count` survivors, and
 * then every survivor becomes a seed.
 */
export function sampleOpenings(
  pool: Opening[],
  count: number,
  sampler: SamplerBody,
  rng: () => number = Math.random,
): string[] {
  const mergedMass = new Map<string, number>();
  for (const opening of pool) {
    const prev = mergedMass.get(opening.token);
    mergedMass.set(
      opening.token,
      prev === undefined ? opening.logprob : logAddExp(prev, opening.logprob),
    );
  }
  if (mergedMass.size === 0 || count <= 0) return [];

  const byLikelihood = [...mergedMass]
    .map(([token, logprob]) => ({ token, logprob }))
    .sort((a, b) => b.logprob - a.logprob);
  const temp = resolveNumber(sampler.temperature, NEUTRALS.temperature);
  if (temp <= 0) {
    return byLikelihood.slice(0, count).map((opening) => opening.token);
  }

  // The truncations inspect the distribution the engine would truncate. That
  // is the temperature-scaled one, unless temperature_last defers the scale to
  // after truncation, and then they see the unscaled one. Weights are relative
  // to the most likely candidate for numerical stability. The pool is sorted
  // most likely first, so each truncation keeps a prefix. Gumbel keys shift by
  // the same constant under any rescaling of the weights, so no
  // renormalization is needed anywhere.
  const tempLast = sampler.temperature_last ?? NEUTRALS.temperature_last ?? false;
  const truncTemp = tempLast ? 1 : temp;
  const maxLogprob = byLikelihood[0]?.logprob ?? 0;
  let survivors = byLikelihood.map((opening) => ({
    ...opening,
    weight: Math.exp((opening.logprob - maxLogprob) / truncTemp),
  }));

  const topK = resolveNumber(sampler.top_k, NEUTRALS.top_k);
  const topKWithinPool = topK > 0 && topK <= survivors.length;
  if (topK > 0 && topK < survivors.length) {
    survivors = survivors.slice(0, topK);
  }

  const topP = resolveNumber(sampler.top_p, NEUTRALS.top_p);
  if (topP > 0 && topP < 1) {
    // The engine renormalizes between truncations, so its nucleus cut runs
    // against the top_k survivors when top_k truncated first, and against the
    // whole vocabulary otherwise. When top_k lands within the pool the
    // survivor set is fully known and its relative weights give the exact
    // mass base at any temperature. Without that, the raw logprobs are
    // already normalized over the vocabulary, so at a truncation temperature
    // of 1 the plain sum of raw probabilities is the exact cumulative mass,
    // and a pool that never reaches top_p lies wholly inside the nucleus and
    // is kept intact. A tempered truncation without top_k has no computable
    // base because the tail mass is not in the probe. Normalizing within the
    // pool is then a deliberate approximation, near exact when temperature
    // sharpens below 1 and biased toward the head when it flattens above 1.
    // The cut keeps tokens whose inclusive cumulative mass stays within
    // top_p and always keeps the most likely token, matching the engine's
    // SS_TopP boundary behavior.
    const usePoolMass = topKWithinPool || truncTemp !== 1;
    const mass = usePoolMass ? survivors.reduce((a, s) => a + s.weight, 0) : 1;
    let cumulative = 0;
    const firstBeyond = survivors.findIndex((s) => {
      cumulative += usePoolMass ? s.weight / mass : Math.exp(s.logprob);
      return cumulative > topP;
    });
    if (firstBeyond !== -1) {
      survivors = survivors.slice(0, Math.max(firstBeyond, 1));
    }
  }

  const minP = resolveNumber(sampler.min_p, NEUTRALS.min_p);
  if (minP > 0) {
    const peak = Math.max(...survivors.map((s) => s.weight));
    survivors = survivors.filter((s) => s.weight >= minP * peak);
  }

  // The key uses the logprob at the drawing temperature rather than the
  // truncation weight, so with temperature_last the draw is still tempered.
  const keyed = survivors.map((s) => {
    // Math.random can return exactly zero, which would make the Gumbel term
    // infinite. Clamp to the smallest positive double.
    const u = rng() || Number.MIN_VALUE;
    return { token: s.token, key: s.logprob / temp - Math.log(-Math.log(u)) };
  });
  keyed.sort((a, b) => b.key - a.key);
  return keyed.slice(0, count).map((entry) => entry.token);
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
 * Run a one-token completion that returns the first token's distribution, then
 * return the candidate openings with their raw logprobs, most likely first (up
 * to `k`, which defaults to the seeded pool size). The candidates come from
 * the raw model distribution, so the probe returns `k` of them whenever the
 * backend reports logprobs at all. An empty result means it reported none, and
 * the caller falls back to a plain n-sample generation.
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
  /** Run the one-token probe and return the candidate pool, most likely first. */
  fetchOpenings: (signal: AbortSignal) => Promise<Opening[]>;
  /** Active project bans. A pool candidate that is itself banned never seeds. */
  bannedStrings: string[];
  /** How many seeds to draw from the pool. */
  seedCount: number;
  /** The request's sampler settings, which shape the seed draw. */
  samplerBody: SamplerBody;
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
 * the first token's distribution, sample one opening per branch from the pool,
 * then fan out one continuation per opening so siblings start differently.
 * Returns true when it drove a seeded generation, and false when the probe
 * returned no usable pool so the caller should run its plain n-sample path. An
 * abort during the probe re-raises so Stop stays silent.
 */
export async function runSeededFanOut(opts: SeededFanOut): Promise<boolean> {
  opts.clearBranchPicker();
  let pool: Opening[];
  try {
    pool = await opts.fetchOpenings(opts.signal);
  } catch (err) {
    // A backend that rejects the logprobs probe shouldn't leave the user with
    // no branches. Re-raise an abort so Stop stays silent. Otherwise fall back
    // to the plain n-sample path by reporting an empty pool.
    if ((err as Error).name === "AbortError") throw err;
    pool = [];
  }

  // Remove banned candidates before the draw so a banned token never consumes
  // a seed slot and the draw keeps its full count.
  pool = dropBannedOpenings(pool, opts.bannedStrings);

  // Draw the seeds with the request's sampler settings shaping the weights.
  // An empty result means the backend reported no logprobs or every candidate
  // was banned or truncated away, so fall back to the plain n-sample path.
  const seeds = sampleOpenings(pool, opts.seedCount, opts.samplerBody, opts.rng);
  if (seeds.length === 0) return false;

  opts.beginSeeded(seeds);
  // The seed is the branch's first token, so it counts against the token
  // budget. Generate one fewer continuation token. If the seed alone exhausts
  // the budget the branch is just the seed.
  const continuationMax = opts.resolvedMaxTokens - 1;
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
      if (continuationMax <= 0) return Promise.resolve();
      return opts
        .streamSeed(seed, slot, continuationMax, opts.signal)
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
