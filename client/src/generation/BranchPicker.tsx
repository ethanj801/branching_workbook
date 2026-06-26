import { type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";

import type { ComposeDisplayMode } from "../api";
import type { Candidate } from "../candidates";
import { previewText } from "../nodeMapLayout";
import BranchCard from "./BranchCard";
import type { BranchViewMode } from "./useCandidates";

type BranchPickerProps = {
  candidates: Candidate[];
  savedCandidateIds: Record<number, string>;
  pickedCandidateIndex: number | null;
  branchViewMode: BranchViewMode;
  composeDisplayMode: ComposeDisplayMode;
  branchPaneRatio: number;
  streaming: boolean;
  saving: boolean;
  branchColumns: number | null;
  firstCenteredBranchIndex: number | null;
  centeredBranchStart: number | null;
  onUseCandidate: (index: number) => void;
  onKeepCandidate: (index: number) => void | Promise<void>;
  clearBranchPicker: () => void;
  dropCandidate: (index: number) => void;
  setBranchViewMode: (mode: BranchViewMode) => void;
  startRowDrag: (event: ReactMouseEvent<HTMLDivElement>) => void;
  pinManuscriptScroll: () => () => void;
};

/**
 * The prose branch picker: the grid of branch cards with a resize splitter
 * (cards display), and the collapsed strip after a branch is used. Rendered
 * only in compose mode with a prose generation open. Presentational — all state
 * and actions are App's, passed in as props.
 */
export default function BranchPicker({
  candidates,
  savedCandidateIds,
  pickedCandidateIndex,
  branchViewMode,
  composeDisplayMode,
  branchPaneRatio,
  streaming,
  saving,
  branchColumns,
  firstCenteredBranchIndex,
  centeredBranchStart,
  onUseCandidate,
  onKeepCandidate,
  clearBranchPicker,
  dropCandidate,
  setBranchViewMode,
  startRowDrag,
  pinManuscriptScroll,
}: BranchPickerProps) {
  return (
    <>
      {branchViewMode === "grid" && composeDisplayMode === "cards" && (
        <section
          className="bw-branch-comparison"
          style={{ flexBasis: `${branchPaneRatio * 100}%` }}
        >
          <div className="bw-branch-comparison-head">
            <div>
              <div className="bw-kicker">Branches</div>
              <div className="bw-branch-context">
                {candidates.length} candidate
                {candidates.length === 1 ? "" : "s"}
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
          <div
            className="bw-branch-grid"
            data-balanced={branchColumns !== null}
            style={
              branchColumns === null
                ? undefined
                : ({
                    "--branch-grid-tracks": branchColumns * 2,
                  } as CSSProperties)
            }
          >
            {candidates.map((candidate, index) => {
              const kept = !!savedCandidateIds[index];
              const picked = pickedCandidateIndex === index;
              const centeredStart =
                firstCenteredBranchIndex === index && centeredBranchStart
                  ? centeredBranchStart
                  : null;
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
                  style={
                    centeredStart === null
                      ? undefined
                      : { gridColumn: `${centeredStart} / span 2` }
                  }
                />
              );
            })}
          </div>
        </section>
      )}

      {branchViewMode === "grid" && composeDisplayMode === "cards" && (
        <div
          className="bw-row-splitter"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize branch comparison"
          onMouseDown={startRowDrag}
        />
      )}

      {/* The collapsed strip uses its own compact "mini" card (preview text,
          Expand / Drop, click-to-expand) — a deliberately different shape from
          the full grid/chat card, so it is not a BranchCard. */}
      {branchViewMode === "strip" && (
        <section className="bw-branch-strip">
          <div className="bw-branch-strip-label">
            <span className="bw-kicker">Last generation</span>
            <span>{candidates.length} candidates</span>
          </div>
          <div className="bw-branch-strip-cards">
            {candidates.map((candidate, index) => {
              const picked = pickedCandidateIndex === index;
              const kept = !!savedCandidateIds[index];
              const hasText = candidate.text.length > 0;
              return (
                <div key={index} className="bw-branch-mini" data-picked={picked}>
                  <button
                    type="button"
                    className="bw-branch-mini-main"
                    onClick={() => {
                      const restore = pinManuscriptScroll();
                      setBranchViewMode("grid");
                      restore();
                    }}
                    title="Expand last generation"
                  >
                    <span className="bw-branch-mini-label">
                      {picked ? "✓ " : ""}
                      Branch {index + 1}
                    </span>
                    <span className="bw-branch-mini-preview">
                      {hasText ? previewText(candidate.text) : "No text."}
                    </span>
                  </button>
                  <div className="bw-branch-mini-actions">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        void onKeepCandidate(index);
                      }}
                      disabled={!hasText || saving || kept}
                      title={kept ? "Already kept" : "Keep branch"}
                    >
                      {kept ? "Kept" : "Keep"}
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onUseCandidate(index);
                      }}
                      disabled={!hasText || saving || picked}
                      title={picked ? "Already used" : "Use instead"}
                    >
                      Use instead
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        const restore = pinManuscriptScroll();
                        setBranchViewMode("grid");
                        restore();
                      }}
                      title="Expand branches"
                    >
                      Expand
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        dropCandidate(index);
                      }}
                      disabled={saving || streaming}
                      aria-label={`Drop branch ${index + 1}`}
                      title="Drop this branch from the strip"
                    >
                      Drop
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            className="bw-branch-strip-close"
            onClick={clearBranchPicker}
            aria-label="Clear last generation"
            title="Clear last generation"
          >
            ×
          </button>
        </section>
      )}
    </>
  );
}
