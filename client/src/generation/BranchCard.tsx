import { type CSSProperties } from "react";

import { isCandidateUsable, type Candidate } from "../candidates";
import { displayBranchText } from "../nodeMapLayout";
import { approxTokenCount } from "../tokens";

/*
 * The one description of each action, shared by the button tooltips here and
 * the chat picker legend, so the two surfaces cannot drift apart.
 */
export const USE_ACTION_DESCRIPTION =
  "commits the chunk to the active path and continues from it";
export const KEEP_ACTION_DESCRIPTION =
  "saves the chunk as a hidden sibling to compare or resume later";

type BranchCardProps = {
  candidate: Candidate;
  index: number;
  streaming: boolean;
  saving: boolean;
  kept: boolean;
  picked: boolean;
  onUseCandidate: (index: number) => void;
  onKeepCandidate: (index: number) => void | Promise<void>;
  /** Extra class on the card root (e.g. the chat variant). */
  className?: string;
  /** Inline style on the card root (e.g. the grid's centered last row). */
  style?: CSSProperties;
};

/**
 * One branch card: the "Branch N" header with token count, the streamed text,
 * and the Use / Keep actions. Shared by the prose grid (BranchPicker) and the
 * chat next-chunk picker (ChatCandidateCards).
 */
export default function BranchCard({
  candidate,
  index,
  streaming,
  saving,
  kept,
  picked,
  onUseCandidate,
  onKeepCandidate,
  className,
  style,
}: BranchCardProps) {
  const failed = candidate.failed === true;
  const hasText = candidate.text.length > 0;
  const isStreaming = streaming && !candidate.done;
  // A failed slot streamed an error, so its text is partial or seed-only. Treat
  // it as not usable. Disable Use/Keep and show the failure in place of the text.
  const usable = isCandidateUsable(candidate);
  return (
    <section
      className={`bw-branch-card${className ? ` ${className}` : ""}`}
      data-empty={!hasText}
      data-streaming={isStreaming}
      data-picked={picked}
      data-failed={failed}
      style={style}
    >
      <div className="bw-branch-card-head">
        <div className="bw-branch-card-title">
          <span>Branch {index + 1}</span>
          {picked && <span className="bw-branch-used-badge">Used</span>}
          {isStreaming && <span className="bw-branch-pulse" aria-label="Streaming" />}
        </div>
        {usable && (
          <span className="bw-branch-token-count">
            {approxTokenCount(candidate.text)} tok
          </span>
        )}
      </div>
      <div className="bw-branch-text">
        {failed ? (
          <span className="bw-empty">Generation failed.</span>
        ) : hasText ? (
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
          disabled={!usable || streaming || saving || picked}
          className={`bw-button ${picked ? "bw-button-used" : "bw-button-primary"}`}
          title={`Use ${USE_ACTION_DESCRIPTION}`}
        >
          {picked ? "Used" : "Use"}
        </button>
        {/*
          Keep is blocked only while this candidate's own stream is live
          (isStreaming). Once a candidate finishes it stays keepable even when a
          sibling is still generating. This is what lets chat save a turn to
          continue. A turn that stopped on length is done with endOfTurn false,
          and keeping it persists the turn so a later Generate resumes it through
          response_prefix. Keeping while tokens are still arriving would instead
          freeze an arbitrary prefix while the branch kept growing past it.
        */}
        <button
          type="button"
          onClick={() => void onKeepCandidate(index)}
          disabled={!usable || saving || kept || isStreaming}
          className="bw-button"
          title={`Keep ${KEEP_ACTION_DESCRIPTION}`}
        >
          {kept ? "Kept" : "Keep"}
        </button>
      </div>
    </section>
  );
}
