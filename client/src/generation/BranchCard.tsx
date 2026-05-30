import { type CSSProperties } from "react";

import type { Candidate } from "../candidates";
import { displayBranchText } from "../nodeMapLayout";
import { approxTokenCount } from "../tokens";

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
  /** Disable Keep while streaming — true in the prose grid, false in chat. */
  keepDisabledWhileStreaming?: boolean;
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
  keepDisabledWhileStreaming = false,
}: BranchCardProps) {
  const hasText = candidate.text.length > 0;
  const isStreaming = streaming && !candidate.done;
  return (
    <section
      className={`bw-branch-card${className ? ` ${className}` : ""}`}
      data-empty={!hasText}
      data-streaming={isStreaming}
      data-picked={picked}
      style={style}
    >
      <div className="bw-branch-card-head">
        <div className="bw-branch-card-title">
          <span>Branch {index + 1}</span>
          {picked && <span className="bw-branch-used-badge">Used</span>}
          {isStreaming && <span className="bw-branch-pulse" aria-label="Streaming" />}
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
          className={`bw-button ${picked ? "bw-button-used" : "bw-button-primary"}`}
        >
          {picked ? "Used" : "Use"}
        </button>
        <button
          type="button"
          onClick={() => void onKeepCandidate(index)}
          disabled={
            !hasText || saving || kept || (keepDisabledWhileStreaming && streaming)
          }
          className="bw-button"
        >
          {kept ? "Kept" : "Keep"}
        </button>
      </div>
    </section>
  );
}
