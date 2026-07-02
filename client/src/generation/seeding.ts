import {
  streamChatCompletion,
  streamCompletion,
  type ChatCompletionRequestBody,
  type CompletionRequestBody,
  type SamplerBody,
} from "../api";
import { markCandidateDone, markCandidateFailed, type Candidate } from "../candidates";
import { mergePreset } from "../samplers/fields";

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
 * Order a completion-endpoint top_logprobs map (token string to logprob) from
 * most to least likely, returning the token strings. The completion endpoint
 * returns each position as a flat map.
 */
export function rankCompletionTop(
  top: Record<string, number> | null | undefined,
): string[] {
  if (!top) return [];
  return Object.entries(top)
    .sort((a, b) => b[1] - a[1])
    .map(([token]) => token);
}

/**
 * Order a chat-endpoint top_logprobs list from most to least likely. The chat
 * endpoint returns each position as a ranked list of `{ token, logprob }`.
 */
export function rankChatTop(
  top: { token: string; logprob: number }[] | null | undefined,
): string[] {
  if (!top) return [];
  return [...top].sort((a, b) => b.logprob - a.logprob).map((leaf) => leaf.token);
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
 * Remove openings that are themselves a banned phrase. The probe reads the raw
 * model distribution, which the ban list does not constrain, so a banned token
 * can rank first. A seed goes into the prompt verbatim, so a seed equal to a
 * banned phrase would open the branch with banned text. Matching is exact on the
 * trimmed lowercased text, so banning a common word does not also drop the many
 * openings that merely contain it. Later continuation tokens stay suppressed by
 * banned_strings.
 */
export function dropBannedOpenings(openings: string[], banned: string[]): string[] {
  const needles = new Set(
    banned.map((b) => b.toLowerCase().trim()).filter((b) => b.length > 0),
  );
  if (needles.size === 0) return openings;
  return openings.filter((opening) => !needles.has(opening.toLowerCase().trim()));
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
 * return the ranked candidate openings (up to `k`). The top tokens come from the
 * raw model distribution, so the probe returns `k` distinct tokens whenever the
 * backend reports logprobs at all. An empty result means it reported none, and
 * the caller falls back to a plain n-sample generation.
 */
export async function fetchProseOpenings(
  body: Omit<CompletionRequestBody, "n" | "max_tokens" | "logprobs" | "top_logprobs">,
  k: number,
  signal: AbortSignal,
): Promise<string[]> {
  // Request the same count on both fields. The exllamav3 backend drives the
  // returned candidate count from top_logprobs. The exllamav2 backend drives it
  // from logprobs. Setting one alone collapses the openings to a single token on
  // the other backend. logprobs > 0 also gates per-token logprob collection.
  let ranked: string[] = [];
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
  k: number,
  signal: AbortSignal,
): Promise<string[]> {
  let ranked: string[] = [];
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
  /** Run the one-token probe and return the ranked openings. */
  fetchOpenings: (signal: AbortSignal) => Promise<string[]>;
  /** Active project bans, so an opening that is itself banned is dropped. */
  bannedStrings: string[];
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
 * the first token's distribution, then fan out one continuation per opening so
 * siblings start differently. Returns true when it drove a seeded generation,
 * and false when the probe returned no openings so the caller should run its
 * plain n-sample path. An abort during the probe re-raises so Stop stays silent.
 */
export async function runSeededFanOut(opts: SeededFanOut): Promise<boolean> {
  opts.clearBranchPicker();
  let seeds: string[];
  try {
    seeds = await opts.fetchOpenings(opts.signal);
  } catch (err) {
    // A backend that rejects the logprobs probe shouldn't leave the user with
    // no branches. Re-raise an abort so Stop stays silent. Otherwise fall back
    // to the plain n-sample path by reporting no seeds.
    if ((err as Error).name === "AbortError") throw err;
    seeds = [];
  }

  // Drop any opening that is itself banned before it becomes a seed. The probe
  // ignores the ban list, so a banned token can rank first and would otherwise
  // open the kept branch with banned text.
  seeds = dropBannedOpenings(seeds, opts.bannedStrings);

  // The probe reads the raw top-k first tokens, so the probe result is either
  // empty (the backend reported no logprobs) or the requested count, and the
  // ban filter above can only shrink it. An empty list here means there is
  // nothing to seed, so fall back to the plain n-sample path.
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
