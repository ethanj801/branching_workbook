import { useLayoutEffect, useRef, type Dispatch, type SetStateAction } from "react";

import AutoGrowTextarea from "../AutoGrowTextarea";
import type { Candidate } from "../candidates";
import { displayBranchText } from "../nodeMapLayout";
import { approxTokenCount } from "../tokens";
import type { TreeNode } from "../tree/types";
import ChatCandidateCards from "./ChatCandidateCards";
import type { ChatTurn, ChatTurnDraft } from "./turns";

type ChatSurfaceProps = {
  chatTurns: ChatTurn[];
  chatTailTurn: ChatTurn | null;
  chatTailNode: TreeNode | null;
  chatTurnDrafts: Record<string, ChatTurnDraft>;
  setChatTurnDrafts: Dispatch<SetStateAction<Record<string, ChatTurnDraft>>>;
  chatUserDraft: string;
  setChatUserDraft: Dispatch<SetStateAction<string>>;
  chatCanComposeUser: boolean;
  chatSystemNode: TreeNode | null;
  chatSystemExpanded: boolean;
  setChatSystemExpanded: Dispatch<SetStateAction<boolean>>;
  chatSystemDraft: string;
  setChatSystemDraft: Dispatch<SetStateAction<string>>;
  branchPickerOpen: boolean;
  candidateContext: "prose" | "chat";
  saving: boolean;
  streaming: boolean;
  commitChatDraftsAndPersist: () => void;
  onEndChatAssistantTurn: () => void;
  onDeleteChatTurn: (turn: ChatTurn) => void;
  onSubmitChatUser: () => void;
  onSaveChatSystem: () => void;
  // Forwarded to the candidate picker for the active assistant turn.
  candidates: Candidate[];
  savedCandidateIds: Record<number, string>;
  pickedCandidateIndex: number | null;
  onUseCandidate: (index: number) => void;
  onKeepCandidate: (index: number) => void | Promise<void>;
  clearBranchPicker: () => void;
};

/**
 * The chat workspace transcript: the system prompt, the turn-by-turn history
 * with inline editors, the in-progress assistant candidate picker, and the
 * user compose box. Presentational — all state and actions are App's, passed
 * in as props.
 */
export default function ChatSurface({
  chatTurns,
  chatTailTurn,
  chatTailNode,
  chatTurnDrafts,
  setChatTurnDrafts,
  chatUserDraft,
  setChatUserDraft,
  chatCanComposeUser,
  chatSystemNode,
  chatSystemExpanded,
  setChatSystemExpanded,
  chatSystemDraft,
  setChatSystemDraft,
  branchPickerOpen,
  candidateContext,
  saving,
  streaming,
  commitChatDraftsAndPersist,
  onEndChatAssistantTurn,
  onDeleteChatTurn,
  onSubmitChatUser,
  onSaveChatSystem,
  candidates,
  savedCandidateIds,
  pickedCandidateIndex,
  onUseCandidate,
  onKeepCandidate,
  clearBranchPicker,
}: ChatSurfaceProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Closing the candidate picker (Use / Clear) removes the candidate grid
  // from below the active turn, shrinking the transcript by the grid's
  // height. The user is scrolled to the bottom reading candidates when they
  // click, so the browser clamps scrollTop upward by that whole height —
  // with a long turn the view lands somewhere inside the block, far from
  // the text they just accepted. (Browsers can make it worse: a focused
  // turn editor's caret-into-view, or the AutoGrowTextarea re-measure in
  // engines without field-sizing, can yank all the way to the top of the
  // block.) Same family of bugs as the prose-side pinManuscriptScroll.
  //
  // Anchor on distance-from-bottom instead: snapshot it when a click is
  // about to close the picker, and restore it on the render where the
  // picker is gone — so the view stays pinned to the end of the transcript,
  // where the accepted text landed. null = no restore pending.
  const pinnedScrollBottomRef = useRef<number | null>(null);
  const chatPickerOpen = branchPickerOpen && candidateContext === "chat";

  function armScrollPin() {
    const el = scrollRef.current;
    if (!el) return;
    pinnedScrollBottomRef.current = el.scrollHeight - el.clientHeight - el.scrollTop;
  }

  useLayoutEffect(() => {
    if (chatPickerOpen) {
      // A fresh picker session: drop any pin left armed by a close that
      // never happened (e.g. the Use click's save failed).
      pinnedScrollBottomRef.current = null;
      return;
    }
    const distanceFromBottom = pinnedScrollBottomRef.current;
    pinnedScrollBottomRef.current = null;
    if (distanceFromBottom === null) return;
    const el = scrollRef.current;
    if (!el) return;
    const restore = () => {
      const target = Math.max(
        0,
        el.scrollHeight - el.clientHeight - distanceFromBottom,
      );
      if (Math.abs(el.scrollTop - target) > 0.5) {
        el.scrollTop = target;
      }
    };
    // Once before paint, then re-assert across two animation frames to
    // outlast any focus / caret-into-view scrolling the browser dispatches
    // after the state updates settle (the prose pin does the same).
    restore();
    window.requestAnimationFrame(() => {
      restore();
      window.requestAnimationFrame(restore);
    });
  }, [chatPickerOpen]);

  const candidateCards = (
    <ChatCandidateCards
      candidates={candidates}
      streaming={streaming}
      saving={saving}
      savedCandidateIds={savedCandidateIds}
      pickedCandidateIndex={pickedCandidateIndex}
      branchPickerOpen={branchPickerOpen}
      candidateContext={candidateContext}
      onUseCandidate={(index) => {
        armScrollPin();
        onUseCandidate(index);
      }}
      onKeepCandidate={onKeepCandidate}
      clearBranchPicker={() => {
        armScrollPin();
        clearBranchPicker();
      }}
    />
  );

  return (
    <div className="bw-chat-scroll" ref={scrollRef}>
      <section className="bw-chat-transcript" aria-label="Chat transcript">
        <section className="bw-chat-system" data-expanded={chatSystemExpanded}>
          <button
            type="button"
            className="bw-chat-system-toggle"
            onClick={() => setChatSystemExpanded((value) => !value)}
            aria-expanded={chatSystemExpanded}
          >
            <span aria-hidden="true">{chatSystemExpanded ? "⌄" : "›"}</span>
            <span>SYSTEM</span>
            {!chatSystemExpanded && (
              <span className="bw-chat-system-preview">
                {chatSystemNode?.text.trim() || "No system prompt"}
              </span>
            )}
          </button>
          {chatSystemExpanded && (
            <div className="bw-chat-system-editor">
              <AutoGrowTextarea
                value={chatSystemDraft}
                onChange={(event) => setChatSystemDraft(event.target.value)}
                onBlur={() => void onSaveChatSystem()}
                disabled={saving || streaming}
                placeholder="System prompt"
              />
              <button
                type="button"
                className="bw-button"
                onClick={() => void onSaveChatSystem()}
                disabled={
                  saving || streaming || chatSystemDraft === chatSystemNode?.text
                }
              >
                Save
              </button>
            </div>
          )}
        </section>

        {chatTurns
          .filter((turn) => turn.role !== "system")
          .map((turn, index) => {
            const isActiveAssistant =
              turn.role === "assistant" && chatTailTurn === turn && !turn.endOfTurn;
            const turnKey = turn.nodes[0]?.id ?? "";
            const draft = chatTurnDrafts[turnKey];
            const editable = turn.role === "user" || turn.role === "assistant";
            return (
              <section
                key={`${turn.nodes[0]?.id ?? index}-${index}`}
                className="bw-chat-turn"
                data-role={turn.role}
                data-active={isActiveAssistant}
              >
                <div className="bw-chat-turn-head">
                  <span>{turn.role === "user" ? "YOU" : "ASSISTANT"}</span>
                  {isActiveAssistant && (
                    <span>
                      in progress · {approxTokenCount(turn.text).toLocaleString()} tok
                    </span>
                  )}
                </div>
                {editable ? (
                  <AutoGrowTextarea
                    className="bw-chat-turn-editor"
                    data-chat-node-id={turnKey}
                    value={draft?.text ?? turn.text}
                    onChange={(event) => {
                      if (!turnKey) return;
                      const nextText = event.target.value;
                      // Capture turn.text as the baseText snapshot on
                      // first edit; subsequent keystrokes reuse the
                      // existing snapshot so the comparison stays
                      // anchored to what the user started typing
                      // against, not to whatever the turn currently
                      // looks like.
                      setChatTurnDrafts((current) => {
                        const existing = current[turnKey];
                        const baseText = existing?.baseText ?? turn.text;
                        return {
                          ...current,
                          [turnKey]: { text: nextText, baseText },
                        };
                      });
                    }}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                        event.preventDefault();
                        // Cmd+Enter flushes every pending draft via the
                        // unified commit path — matches Cmd+S / the
                        // actionbar Save button exactly so editor
                        // shortcuts and global save can never drift.
                        void commitChatDraftsAndPersist();
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        if (turnKey) {
                          setChatTurnDrafts((current) => {
                            const next = { ...current };
                            delete next[turnKey];
                            return next;
                          });
                        }
                        event.currentTarget.blur();
                      }
                    }}
                    disabled={saving || streaming}
                    aria-label={`Edit ${turn.role} turn`}
                  />
                ) : (
                  <div className="bw-chat-turn-text">
                    {displayBranchText(turn.text)}
                  </div>
                )}
                {isActiveAssistant && candidateCards}
                {isActiveAssistant && !branchPickerOpen && (
                  <div className="bw-chat-turn-actions">
                    <button
                      type="button"
                      className="bw-button"
                      onClick={() => void onEndChatAssistantTurn()}
                      disabled={saving || streaming}
                    >
                      End turn
                    </button>
                  </div>
                )}
                {!isActiveAssistant && (
                  <div className="bw-chat-turn-actions">
                    <button
                      type="button"
                      className="bw-button"
                      onClick={() => void onDeleteChatTurn(turn)}
                      disabled={saving || streaming}
                      title="Hide this turn and any later turns on the active path"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </section>
            );
          })}

        {branchPickerOpen &&
          candidateContext === "chat" &&
          chatTailNode?.role !== "assistant" && (
            <section className="bw-chat-turn" data-role="assistant" data-active="true">
              <div className="bw-chat-turn-head">
                <span>ASSISTANT</span>
                <span>in progress</span>
              </div>
              {candidateCards}
            </section>
          )}

        {chatCanComposeUser && (
          <section className="bw-chat-turn bw-chat-input" data-role="user">
            <div className="bw-chat-turn-head">
              <span>YOU</span>
            </div>
            <AutoGrowTextarea
              value={chatUserDraft}
              onChange={(event) => setChatUserDraft(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  void onSubmitChatUser();
                }
              }}
              disabled={saving || streaming}
              placeholder="Write the next message..."
            />
          </section>
        )}
      </section>
    </div>
  );
}
