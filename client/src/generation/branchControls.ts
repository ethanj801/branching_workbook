import type { TabbyModel } from "../api";

/**
 * Pure branch / generation control logic: the constants, input parsing, and the
 * validation "resolvers" behind the Branches / Max tokens / Tokens-per-suggestion
 * inputs. App owns the state and the side effects (setState, persisting settings);
 * this module owns the *decisions*, so they can be unit tested without a component.
 */

// Branches generated per Generate, by default.
export const DEFAULT_BRANCH_COUNT = 3;
// Completion length per branch, in tokens, by default.
export const DEFAULT_MAX_TOKENS = 256;
// Branch ceiling when the loaded model doesn't advertise a max batch size.
export const DEFAULT_BRANCH_LIMIT = 12;
// Hard cap on branches regardless of model, to keep the grid readable.
export const MAX_BRANCH_UI_LIMIT = 12;
// Tokens generated per autocomplete suggestion, by default.
export const DEFAULT_TOKENS_PER_SUGGESTION = 2;
// Upper bound on tokens-per-suggestion (kept small so autocomplete stays snappy).
export const TOKENS_PER_SUGGESTION_MAX = 8;
// Max-tokens ceiling when no model context length is known.
export const MAX_TOKENS_FALLBACK_CEILING = 32768;

export function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function parsePositiveInt(text: string, fallback: number): number {
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Parse a branch-count input. Returns null for anything that isn't a positive
 * integer, so a caller can leave a partial entry (like "" or "0") untouched
 * instead of fighting the user mid-keystroke.
 */
export function parseBranchCountInput(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return parsed > 0 ? parsed : null;
}

/** The most branches the loaded model can produce, capped for a readable grid. */
export function maxBranchesForModel(model: TabbyModel | null): number {
  const maxBatchSize = model?.parameters?.max_batch_size;
  if (typeof maxBatchSize !== "number" || !Number.isFinite(maxBatchSize)) {
    return DEFAULT_BRANCH_LIMIT;
  }
  return clampNumber(Math.trunc(maxBatchSize), 1, MAX_BRANCH_UI_LIMIT);
}

/** Column count for the branch grid at a given count, or null to auto-flow. */
export function branchGridColumns(count: number): number | null {
  const lookup: Record<number, number> = {
    1: 1,
    2: 2,
    3: 3,
    4: 2,
    5: 3,
    6: 3,
    7: 4,
    8: 4,
    9: 3,
  };
  return lookup[count] ?? null;
}

export type BranchCountResolution =
  | { ok: false; error: string }
  | { ok: true; value: number; limitHint: boolean };

/**
 * Resolve a branch-count input against the model's ceiling. Invalid input is an
 * error (the caller shows it and keeps the previous value); valid input clamps
 * into range, flagging limitHint when it had to come down from a higher number.
 */
export function resolveBranchCount(
  text: string,
  maxBranches: number,
): BranchCountResolution {
  const parsed = parseBranchCountInput(text);
  if (parsed === null) {
    return { ok: false, error: `Enter 1-${maxBranches} branches.` };
  }
  const clamped = clampNumber(parsed, 1, maxBranches);
  return { ok: true, value: clamped, limitHint: parsed > maxBranches };
}

export type MaxTokensResolution = {
  value: number;
  limitHint: boolean;
  error: string | null;
  ceiling: number;
};

/**
 * Resolve a max-tokens input. Empty/garbage snaps to the default and reports an
 * error; an over-ceiling value clamps to the model's context length (or a sane
 * fallback) and flags limitHint. The ceiling is returned so the caller can word
 * the error and hint consistently.
 */
export function resolveMaxTokens(
  text: string,
  contextMax: number | null,
): MaxTokensResolution {
  const trimmed = text.trim();
  const parsed = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : NaN;
  const ceiling = contextMax ?? MAX_TOKENS_FALLBACK_CEILING;
  if (!Number.isFinite(parsed) || parsed < 1) {
    return {
      value: DEFAULT_MAX_TOKENS,
      limitHint: false,
      error: `Enter 1-${ceiling.toLocaleString()} tokens.`,
      ceiling,
    };
  }
  const clamped = Math.min(parsed, ceiling);
  return { value: clamped, limitHint: parsed > ceiling, error: null, ceiling };
}

/** Resolve a tokens-per-suggestion input, clamping into [1, TOKENS_PER_SUGGESTION_MAX]. */
export function resolveTokensPerSuggestion(text: string): number {
  return clampNumber(
    parsePositiveInt(text, DEFAULT_TOKENS_PER_SUGGESTION),
    1,
    TOKENS_PER_SUGGESTION_MAX,
  );
}
