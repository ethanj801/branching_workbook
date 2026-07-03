import { useCallback, useEffect, useRef, useState } from "react";

import type { ProjectSettingsPatch } from "../api";
import {
  DEFAULT_BRANCH_COUNT,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TOKENS_PER_SUGGESTION,
  resolveBranchCount,
  resolveMaxTokens,
  resolveTokensPerSuggestion,
} from "./branchControls";
import { SEEDED_BRANCH_CAP } from "./seeding";

type BranchControlSettings = {
  branch_count: number;
  max_tokens: number;
  tokens_per_suggestion: number;
  seeded_branches: boolean;
};

type UseBranchControlsArgs = {
  /** The most branches the loaded model allows, capped for the grid. */
  maxBranches: number;
  /** The loaded model's context length, or null when no model is loaded. */
  contextMax: number | null;
  /** Persist a settings patch (lives in App, talks to the API). */
  saveProjectSettings: (patch: ProjectSettingsPatch) => void;
};

/**
 * Owns the Branches / Max tokens / Tokens-per-suggestion inputs: their text
 * state, real-time and on-blur validation, the one-time re-clamp when the
 * model's branch ceiling changes, and persistence. The pure decisions live in
 * branchControls.ts; this hook is the stateful shell around them, so App holds
 * a single `branchControls` object instead of seven loose useState calls.
 */
export function useBranchControls({
  maxBranches,
  contextMax,
  saveProjectSettings,
}: UseBranchControlsArgs) {
  const [branchCountText, setBranchCountText] = useState(String(DEFAULT_BRANCH_COUNT));
  const [branchLimitHint, setBranchLimitHint] = useState(false);
  const [branchCountError, setBranchCountError] = useState<string | null>(null);
  const [maxTokensText, setMaxTokensText] = useState(String(DEFAULT_MAX_TOKENS));
  const [maxTokensError, setMaxTokensError] = useState<string | null>(null);
  const [maxTokensLimitHint, setMaxTokensLimitHint] = useState(false);
  const [tokensPerSuggestionText, setTokensPerSuggestionText] = useState(
    String(DEFAULT_TOKENS_PER_SUGGESTION),
  );
  const [seededBranches, setSeededBranches] = useState(false);

  // The branch count the user actually asked for, before any ceiling clamped
  // it. The re-clamp effect resolves from this instead of the visible text, so
  // a count squeezed down by a low ceiling springs back when the ceiling rises
  // again (toggling Diverse off, loading a bigger model).
  const requestedBranchCount = useRef(String(DEFAULT_BRANCH_COUNT));

  // The ceiling the Branches input enforces right now. Diverse (seeded)
  // generation streams one HTTP request per branch, so it caps lower than the
  // plain batched path. See SEEDED_BRANCH_CAP.
  const branchCap = seededBranches
    ? Math.min(maxBranches, SEEDED_BRANCH_CAP)
    : maxBranches;

  // Re-resolve the branch count only when the allowed ceiling changes (a model
  // swap or the Diverse toggle). Resolving the requested count against the new
  // ceiling restores a previously clamped value when the ceiling rises, and
  // refreshes the hint and error so neither quotes a stale range. Normalizing
  // on every keystroke would reintroduce the leading-zero bug, so this
  // deliberately depends on the ceiling alone.
  useEffect(() => {
    const requested = requestedBranchCount.current;
    if (requested.trim() === "") return;
    const result = resolveBranchCount(requested, branchCap);
    if (!result.ok) {
      setBranchLimitHint(false);
      setBranchCountError(result.error);
      return;
    }
    setBranchCountText(String(result.value));
    setBranchLimitHint(result.limitHint);
    setBranchCountError(null);
  }, [branchCap]);

  function onBranchCountChange(next: string) {
    requestedBranchCount.current = next;
    setBranchCountText(next);
    setBranchLimitHint(false);
    // Real-time validation: a non-empty, non-digit value (e.g. "abc") used to
    // silently sit there until blur or Generate. Surface it immediately so the
    // user doesn't think a bogus value was accepted. Empty strings stay
    // error-free as a transient mid-edit state — the blur handler covers that.
    if (next.trim() === "" || /^\d+$/.test(next.trim())) {
      setBranchCountError(null);
    } else {
      setBranchCountError(`Enter 1-${branchCap} branches.`);
    }
  }

  function normalizeBranchCount(): number | null {
    const result = resolveBranchCount(branchCountText, branchCap);
    if (!result.ok) {
      setBranchLimitHint(false);
      setBranchCountError(result.error);
      return null;
    }
    setBranchCountText(String(result.value));
    setBranchLimitHint(result.limitHint);
    setBranchCountError(null);
    saveProjectSettings({ branch_count: result.value });
    return result.value;
  }

  function onMaxTokensChange(next: string) {
    setMaxTokensText(next);
    setMaxTokensError(null);
    setMaxTokensLimitHint(false);
  }

  function normalizeMaxTokens(): number {
    // The ceiling mirrors the loaded model's context length when known, so a
    // typo like 999999 doesn't ship a request the backend would silently
    // truncate or reject; empty/garbage snaps to the default and flags, so the
    // user sees what value will actually be sent.
    const result = resolveMaxTokens(maxTokensText, contextMax);
    setMaxTokensText(String(result.value));
    setMaxTokensLimitHint(result.limitHint);
    setMaxTokensError(result.error);
    saveProjectSettings({ max_tokens: result.value });
    return result.value;
  }

  function onTokensPerSuggestionChange(next: string) {
    setTokensPerSuggestionText(next);
  }

  function normalizeTokensPerSuggestion(): number {
    const normalized = resolveTokensPerSuggestion(tokensPerSuggestionText);
    setTokensPerSuggestionText(String(normalized));
    saveProjectSettings({ tokens_per_suggestion: normalized });
    return normalized;
  }

  function onToggleSeededBranches() {
    // Persist outside a setState updater. Updaters double-invoke under
    // StrictMode, which would fire two concurrent settings writes.
    const next = !seededBranches;
    setSeededBranches(next);
    saveProjectSettings({ seeded_branches: next });
  }

  // Hydrate the inputs from saved project settings on project load. Stable
  // (setters only) so callers can list it in effect/callback deps without
  // churning their identity every render.
  const hydrate = useCallback((settings: BranchControlSettings) => {
    requestedBranchCount.current = String(settings.branch_count);
    setBranchCountText(String(settings.branch_count));
    setMaxTokensText(String(settings.max_tokens));
    setTokensPerSuggestionText(String(settings.tokens_per_suggestion));
    setSeededBranches(settings.seeded_branches);
    setBranchLimitHint(false);
    setBranchCountError(null);
  }, []);

  return {
    branchCap,
    branchCountText,
    branchCountError,
    branchLimitHint,
    maxTokensText,
    maxTokensError,
    maxTokensLimitHint,
    tokensPerSuggestionText,
    onBranchCountChange,
    onMaxTokensChange,
    onTokensPerSuggestionChange,
    normalizeBranchCount,
    normalizeMaxTokens,
    normalizeTokensPerSuggestion,
    seededBranches,
    onToggleSeededBranches,
    hydrate,
  };
}

export type BranchControls = ReturnType<typeof useBranchControls>;
