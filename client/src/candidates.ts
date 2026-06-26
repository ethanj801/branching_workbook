import type { CompletionChoice } from "./api";

export type Candidate = {
  text: string;
  done: boolean;
  finishReason: string | null;
  /**
   * Set when a seeded continuation stream errored (as opposed to being
   * aborted). A failed slot is done, but its text is partial or seed-only, so
   * the picker disables Use/Keep on it instead of letting it look successful.
   */
  failed?: boolean;
};

function emptyCandidate(): Candidate {
  return { text: "", done: false, finishReason: null };
}

/** A list of `n` blank candidates — the starting point for a generation. */
export function emptyCandidates(n: number): Candidate[] {
  return Array.from({ length: n }, emptyCandidate);
}

/**
 * The starting point for a seeded generation. One candidate per opening token,
 * each pre-filled with its seed. The seed is the branch's first text because
 * it goes into the request's prompt/response prefix rather than the stream, so
 * the streamed continuation appends onto it.
 */
export function seededCandidates(seeds: string[]): Candidate[] {
  return seeds.map((text) => ({ text, done: false, finishReason: null }));
}

/**
 * Append streamed text to one fixed slot. Seeded continuations each run as
 * their own single-sample request whose choice index is always 0, so the slot is
 * tracked by the caller rather than read off the choice.
 */
export function appendToCandidate(
  current: Candidate[],
  index: number,
  text: string,
  finishReason: string | null,
): Candidate[] {
  return foldChunk(current, index, text, finishReason, current.length);
}

function markCandidate(
  current: Candidate[],
  index: number,
  failed: boolean,
): Candidate[] {
  const existing = current[index];
  if (!existing) return current;
  const next = [...current];
  next[index] = failed
    ? { ...existing, done: true, failed: true }
    : { ...existing, done: true };
  return next;
}

/** Mark one slot done, used when a seeded continuation aborts. */
export function markCandidateDone(current: Candidate[], index: number): Candidate[] {
  return markCandidate(current, index, false);
}

/** Mark one slot done and failed, used when a seeded continuation errors. */
export function markCandidateFailed(current: Candidate[], index: number): Candidate[] {
  return markCandidate(current, index, true);
}

/**
 * Whether a candidate can be used or kept. It exists, has text, and did not
 * fail. Every action boundary (the cards, the inline controls, the Tab accept,
 * and the command handlers) checks this so a failed seed-only slot can't be
 * committed.
 */
export function isCandidateUsable(candidate: Candidate | undefined | null): boolean {
  return candidate != null && candidate.text.length > 0 && candidate.failed !== true;
}

/**
 * Resolve a candidate's text for a Use or Keep action, or null when it can't be
 * acted on. On null it reports why through `setError`, distinguishing a failed
 * slot from an empty one, worded with `verb` ("using" or "keeping"). Every Use
 * and Keep handler shares this so a failed seed-only slot can't be committed.
 */
export function usableCandidateText(
  candidate: Candidate | undefined | null,
  verb: string,
  setError: (message: string) => void,
): string | null {
  if (!isCandidateUsable(candidate)) {
    setError(
      candidate?.failed
        ? "This branch failed to generate. Pick another."
        : `Select a branch with text before ${verb} it.`,
    );
    return null;
  }
  return candidate?.text ?? "";
}

/**
 * Fold one streamed chunk into the candidate list at a fixed slot. Grows the
 * list to `n` slots if an earlier chunk left it a different length, appends the
 * text to that slot, and carries the finish reason once it arrives. The
 * completion and chat streams share this. They differ only in which wire field
 * holds the text, so each reads its own field and passes the plain text in.
 * Pure so the streaming accumulation can be tested without a live model.
 */
export function foldChunk(
  current: Candidate[],
  index: number,
  text: string,
  finishReason: string | null,
  n: number,
): Candidate[] {
  const next =
    current.length === n
      ? [...current]
      : Array.from({ length: n }, (_, i) => current[i] ?? emptyCandidate());
  const existing = next[index] ?? emptyCandidate();
  next[index] = {
    text: existing.text + text,
    done: existing.done || finishReason !== null,
    finishReason: finishReason ?? existing.finishReason,
  };
  return next;
}

/** Fold a completion-endpoint choice, reading its text and slot off the choice. */
export function applyChoice(
  current: Candidate[],
  choice: CompletionChoice,
  n: number,
): Candidate[] {
  return foldChunk(current, choice.index, choice.text, choice.finish_reason, n);
}
