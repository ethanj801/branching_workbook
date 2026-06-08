import type { Candidate } from "../candidates";
import { displayBranchText } from "../nodeMapLayout";
import { approxTokenCount } from "../tokens";

type ChatCandidateCardsProps = {
  candidates: Candidate[];
  streaming: boolean;
  saving: boolean;
  savedCandidateIds: Record<number, string>;
  pickedCandidateIndex: number | null;
  branchPickerOpen: boolean;
  candidateContext: "prose" | "chat";
  onUseCandidate: (index: number) => void;
  onKeepCandidate: (index: number) => void | Promise<void>;
  clearBranchPicker: () => void;
};

/**
 * The chat "next chunk" candidate picker: the streamed branches for the active
 * assistant turn, with Use/Keep actions. Presentational — all state and actions
 * come from App via props.
 */
export default function ChatCandidateCards({
  candidates,
  streaming,
  saving,
  savedCandidateIds,
  pickedCandidateIndex,
  branchPickerOpen,
  candidateContext,
  onUseCandidate,
  onKeepCandidate,
  clearBranchPicker,
}: ChatCandidateCardsProps) {
  if (!branchPickerOpen || candidateContext !== "chat") return null;
  return (
    <div className="bw-chat-candidate-area">
      <div className="bw-chat-candidate-head">
        <div>
          <div className="bw-kicker">Next chunk</div>
          <div className="bw-branch-context">
            {candidates.length} candidate{candidates.length === 1 ? "" : "s"}
            {streaming ? " generating" : " ready"}
          </div>
        </div>
        <button
          type="button"
          onClick={clearBranchPicker}
          disabled={streaming || saving}
          className="bw-button bw-branch-clear"
        >
          Clear
        </button>
      </div>
      <div className="bw-chat-candidate-grid">
        {candidates.map((candidate, index) => {
          const hasText = candidate.text.length > 0;
          const isStreaming = streaming && !candidate.done;
          const kept = !!savedCandidateIds[index];
          const picked = pickedCandidateIndex === index;
          return (
            <section
              key={index}
              className="bw-branch-card bw-chat-branch-card"
              data-empty={!hasText}
              data-streaming={isStreaming}
              data-picked={picked}
            >
              <div className="bw-branch-card-head">
                <div className="bw-branch-card-title">
                  <span>Branch {index + 1}</span>
                  {picked && <span className="bw-branch-used-badge">Used</span>}
                  {isStreaming && (
                    <span className="bw-branch-pulse" aria-label="Streaming" />
                  )}
                </div>
                {hasText && (
                  <span className="bw-branch-token-count">
                    {approxTokenCount(candidate.text)} tok
                  </span>
                )}
              </div>
              <div className="bw-branch-text">
                {hasText ? (
                  displayBranchText(candidate.text)
                ) : (
                  <span className="bw-empty">
                    {streaming ? "Waiting for tokens..." : "No text."}
                  </span>
                )}
              </div>
              <div className="bw-branch-actions">
                <button
                  type="button"
                  onClick={() => onUseCandidate(index)}
                  disabled={!hasText || streaming || saving || picked}
                  className={`bw-button ${
                    picked ? "bw-button-used" : "bw-button-primary"
                  }`}
                >
                  {picked ? "Used" : "Use"}
                </button>
                <button
                  type="button"
                  onClick={() => void onKeepCandidate(index)}
                  disabled={!hasText || saving || kept}
                  className="bw-button"
                >
                  {kept ? "Kept" : "Keep"}
                </button>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
