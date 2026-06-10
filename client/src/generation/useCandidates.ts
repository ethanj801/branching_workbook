import { useCallback, useState } from "react";

import type { SamplerBody } from "../api";
import { type Candidate, emptyCandidates } from "../candidates";

export type CandidateContext = "prose" | "chat";
export type BranchViewMode = "grid" | "strip";
export type UsedCandidateRange = { start: number; end: number };

/** Wrap `current + delta` into `[0, length)`. */
export function cycleIndex(current: number, delta: number, length: number): number {
  return (current + delta + length) % length;
}

export type DropResult = {
  candidates: Candidate[];
  savedCandidateIds: Record<number, string>;
  pickedCandidateIndex: number | null;
  visibleCandidateIndex: number;
};

/**
 * Drop one candidate and re-index the surviving picked / saved / visible
 * markers (everything past the dropped slot shifts down one). Returns null when
 * the drop empties the strip — the caller should clear the picker entirely.
 */
export function applyDrop(
  candidates: Candidate[],
  savedCandidateIds: Record<number, string>,
  pickedCandidateIndex: number | null,
  visibleCandidateIndex: number,
  dropIndex: number,
): DropResult | null {
  const nextCandidates = candidates.filter((_, index) => index !== dropIndex);
  if (nextCandidates.length === 0) return null;

  const nextSaved: Record<number, string> = {};
  for (const [rawIndex, nodeId] of Object.entries(savedCandidateIds)) {
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index === dropIndex) continue;
    nextSaved[index > dropIndex ? index - 1 : index] = nodeId;
  }

  const nextPicked =
    pickedCandidateIndex === null || pickedCandidateIndex === dropIndex
      ? null
      : pickedCandidateIndex > dropIndex
        ? pickedCandidateIndex - 1
        : pickedCandidateIndex;

  const nextVisible =
    visibleCandidateIndex === dropIndex
      ? Math.min(dropIndex, nextCandidates.length - 1)
      : Math.min(
          visibleCandidateIndex > dropIndex
            ? visibleCandidateIndex - 1
            : visibleCandidateIndex,
          nextCandidates.length - 1,
        );

  return {
    candidates: nextCandidates,
    savedCandidateIds: nextSaved,
    pickedCandidateIndex: nextPicked,
    visibleCandidateIndex: nextVisible,
  };
}

/** The fixed facts about a generation, captured when it starts. */
export type GenerationSeed = {
  context: CandidateContext;
  count: number;
  prompt: string;
  baseId: string;
  modelId: string;
  samplerSnapshot: SamplerBody;
};

type UseCandidatesArgs = {
  streaming: boolean;
  saving: boolean;
};

/**
 * Owns the in-progress candidate set (the branch picker): the streamed
 * candidates plus the generation context, the saved/picked/used markers, and
 * the grid/strip view. App keeps the orchestration that touches the editor
 * buffer and the tree (onGenerate / onUseCandidate / onKeepCandidate) and calls
 * the semantic actions here for the candidate-state parts.
 */
export function useCandidates({ streaming, saving }: UseCandidatesArgs) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [candidateContext, setCandidateContext] = useState<CandidateContext>("prose");
  const [candidatePrompt, setCandidatePrompt] = useState<string | null>(null);
  const [candidateBaseId, setCandidateBaseId] = useState<string | null>(null);
  const [candidateModelId, setCandidateModelId] = useState<string | null>(null);
  const [candidateSamplerSnapshot, setCandidateSamplerSnapshot] =
    useState<SamplerBody | null>(null);
  const [savedCandidateIds, setSavedCandidateIds] = useState<Record<number, string>>(
    {},
  );
  const [pickedCandidateIndex, setPickedCandidateIndex] = useState<number | null>(null);
  const [usedCandidateRange, setUsedCandidateRange] =
    useState<UsedCandidateRange | null>(null);
  const [visibleCandidateIndex, setVisibleCandidateIndex] = useState(0);
  const [branchViewMode, setBranchViewMode] = useState<BranchViewMode>("grid");

  const branchPickerOpen = candidatePrompt !== null;
  const visibleCandidate = candidates[visibleCandidateIndex] ?? null;

  const clearBranchPicker = useCallback(() => {
    setCandidates([]);
    setCandidateContext("prose");
    setCandidatePrompt(null);
    setCandidateBaseId(null);
    setCandidateModelId(null);
    setCandidateSamplerSnapshot(null);
    setSavedCandidateIds({});
    setPickedCandidateIndex(null);
    setUsedCandidateRange(null);
    setVisibleCandidateIndex(0);
    setBranchViewMode("grid");
  }, []);

  /** Seed state for a new generation; the caller streams chunks in via setCandidates. */
  function startGeneration(seed: GenerationSeed) {
    setCandidates(emptyCandidates(seed.count));
    setCandidateContext(seed.context);
    setCandidatePrompt(seed.prompt);
    setCandidateBaseId(seed.baseId);
    setCandidateModelId(seed.modelId);
    setCandidateSamplerSnapshot(seed.samplerSnapshot);
    setSavedCandidateIds({});
    setPickedCandidateIndex(null);
    setUsedCandidateRange(null);
    setVisibleCandidateIndex(0);
    setBranchViewMode("grid");
  }

  /** Mark a candidate as the one spliced into the buffer (switches to the strip). */
  function markUsed(index: number, range: UsedCandidateRange) {
    setUsedCandidateRange(range);
    setPickedCandidateIndex(index);
    setBranchViewMode("strip");
  }

  /** Record the tree node a kept candidate was saved as. */
  function markKept(index: number, nodeId: string) {
    setSavedCandidateIds((current) => ({ ...current, [index]: nodeId }));
  }

  function cycleVisibleCandidate(delta: 1 | -1): boolean {
    if (!branchPickerOpen || candidates.length <= 1) return false;
    setVisibleCandidateIndex((current) =>
      cycleIndex(current, delta, candidates.length),
    );
    return true;
  }

  function dropCandidate(indexToDrop: number) {
    if (streaming || saving) return;
    const result = applyDrop(
      candidates,
      savedCandidateIds,
      pickedCandidateIndex,
      visibleCandidateIndex,
      indexToDrop,
    );
    if (result === null) {
      clearBranchPicker();
      return;
    }
    setCandidates(result.candidates);
    setSavedCandidateIds(result.savedCandidateIds);
    setPickedCandidateIndex(result.pickedCandidateIndex);
    setVisibleCandidateIndex(result.visibleCandidateIndex);
  }

  return {
    // state
    candidates,
    candidateContext,
    candidatePrompt,
    candidateBaseId,
    candidateModelId,
    candidateSamplerSnapshot,
    savedCandidateIds,
    pickedCandidateIndex,
    usedCandidateRange,
    visibleCandidateIndex,
    branchViewMode,
    // derived
    branchPickerOpen,
    visibleCandidate,
    // setters the caller drives directly (stream accumulation, editor, strip expand)
    setCandidates,
    setVisibleCandidateIndex,
    setBranchViewMode,
    setUsedCandidateRange,
    // semantic actions
    clearBranchPicker,
    startGeneration,
    markUsed,
    markKept,
    cycleVisibleCandidate,
    dropCandidate,
  };
}

export type Candidates = ReturnType<typeof useCandidates>;
