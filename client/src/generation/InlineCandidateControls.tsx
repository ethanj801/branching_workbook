import { isCandidateUsable, type Candidate } from "../candidates";
import { approxTokenCount } from "../tokens";

type InlineCandidateControlsProps = {
  visibleCandidate: Candidate;
  visibleCandidateIndex: number;
  candidatesLength: number;
  streaming: boolean;
  saving: boolean;
  savedCandidateIds: Record<number, string>;
  cycleVisibleCandidate: (delta: 1 | -1) => boolean;
  onUseCandidate: (index: number) => void;
  onKeepCandidate: (index: number) => void | Promise<void>;
  clearBranchPicker: () => void;
};

/**
 * The inline-mode candidate bar: cycles, uses, keeps, or clears the branch that
 * shows as ghost text in the manuscript editor. Rendered under the manuscript
 * in compose + inline + grid mode. Presentational — state and actions are App's.
 */
export default function InlineCandidateControls({
  visibleCandidate,
  visibleCandidateIndex,
  candidatesLength,
  streaming,
  saving,
  savedCandidateIds,
  cycleVisibleCandidate,
  onUseCandidate,
  onKeepCandidate,
  clearBranchPicker,
}: InlineCandidateControlsProps) {
  const usable = isCandidateUsable(visibleCandidate);
  const isStreaming = streaming && !visibleCandidate.done;
  return (
    <div className="bw-inline-controls" data-streaming={isStreaming}>
      {candidatesLength > 1 && (
        <div className="bw-inline-cycler" aria-label="Cycle branches">
          <button
            type="button"
            onClick={() => cycleVisibleCandidate(-1)}
            aria-label="Previous branch"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => cycleVisibleCandidate(1)}
            aria-label="Next branch"
          >
            ›
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={() => onUseCandidate(visibleCandidateIndex)}
        disabled={!usable || streaming || saving}
        className="bw-button bw-button-primary"
      >
        Use
      </button>
      {/*
        Block Keep only while this branch's own stream is live (isStreaming).
        Keeping a branch whose tokens are still arriving would freeze an
        arbitrary prefix while it kept growing past it. A finished branch stays
        keepable. Same rule as the grid cards in BranchCard.
      */}
      <button
        type="button"
        onClick={() => void onKeepCandidate(visibleCandidateIndex)}
        disabled={
          !usable || saving || isStreaming || !!savedCandidateIds[visibleCandidateIndex]
        }
        title={
          savedCandidateIds[visibleCandidateIndex] ? "Already kept" : "Keep branch"
        }
        className="bw-button"
      >
        {savedCandidateIds[visibleCandidateIndex] ? "Kept" : "Keep"}
      </button>
      <button
        type="button"
        onClick={clearBranchPicker}
        disabled={streaming || saving}
        className="bw-button"
      >
        Clear
      </button>
      <span className="bw-inline-placement">inserts at end of draft</span>
      <span className="bw-inline-meta">
        Branch {visibleCandidateIndex + 1}
        {candidatesLength > 1 ? ` of ${candidatesLength}` : ""}
        {usable ? ` · ${approxTokenCount(visibleCandidate.text)} tok` : ""}
        {visibleCandidate.failed
          ? " · generation failed"
          : " · Tab accept · Ctrl+] / [ cycle · Esc clear"}
        {isStreaming && " · streaming"}
      </span>
    </div>
  );
}
