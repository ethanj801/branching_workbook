import type { CompletionChoice } from "./api";

export type Candidate = {
  text: string;
  done: boolean;
  finishReason: string | null;
};

function emptyCandidate(): Candidate {
  return { text: "", done: false, finishReason: null };
}

/** A list of `n` blank candidates — the starting point for a generation. */
export function emptyCandidates(n: number): Candidate[] {
  return Array.from({ length: n }, emptyCandidate);
}

/**
 * Fold one streamed completion choice into the candidate list. Grows the list
 * to `n` slots if an earlier chunk left it a different length, appends the
 * choice's text to its slot, and carries the finish reason once it arrives.
 * Pure so the streaming accumulation can be tested without a live model.
 */
export function applyChoice(
  current: Candidate[],
  choice: CompletionChoice,
  n: number,
): Candidate[] {
  const next =
    current.length === n
      ? [...current]
      : Array.from({ length: n }, (_, index) => current[index] ?? emptyCandidate());
  const existing = next[choice.index] ?? emptyCandidate();
  next[choice.index] = {
    text: existing.text + choice.text,
    done: existing.done || choice.finish_reason !== null,
    finishReason: choice.finish_reason ?? existing.finishReason,
  };
  return next;
}
