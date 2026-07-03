import type { Candidate } from "../candidates";
import BranchCard, {
  KEEP_ACTION_DESCRIPTION,
  USE_ACTION_DESCRIPTION,
} from "../generation/BranchCard";
import type { CandidateContext } from "../generation/useCandidates";

type ChatCandidateCardsProps = {
  candidates: Candidate[];
  streaming: boolean;
  saving: boolean;
  savedCandidateIds: Record<number, string>;
  pickedCandidateIndex: number | null;
  branchPickerOpen: boolean;
  candidateContext: CandidateContext;
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
        <span className="bw-chat-candidate-legend">
          <strong>Use</strong> {USE_ACTION_DESCRIPTION} ·{" "}
          <strong>Keep</strong> {KEEP_ACTION_DESCRIPTION}
        </span>
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
          const kept = !!savedCandidateIds[index];
          const picked = pickedCandidateIndex === index;
          return (
            <BranchCard
              key={index}
              candidate={candidate}
              index={index}
              streaming={streaming}
              saving={saving}
              kept={kept}
              picked={picked}
              onUseCandidate={onUseCandidate}
              onKeepCandidate={onKeepCandidate}
              className="bw-chat-branch-card"
            />
          );
        })}
      </div>
    </div>
  );
}
