import {
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type SetStateAction,
} from "react";

import AutoGrowTextarea from "../AutoGrowTextarea";
import type { Candidate } from "../candidates";
import NodeNameEditor from "../NodeNameEditor";
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
  onRenameChatNode: (nodeId: string, name: string | null) => void | Promise<void>;
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
  onRenameChatNode,
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

  // The candidate pane splits the workspace vertically while the picker is
  // open: transcript above, candidates below, mirroring the prose branch
  // comparison but hung from the bottom so each option sits directly under
  // the text it would continue. Resizable via the splitter; the ratio is
  // the pane's share of the workspace height.
  const [chatPaneRatio, setChatPaneRatio] = useState(0.4);

  function startChatPaneDrag(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault();
    const container = event.currentTarget.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();

    function onMove(ev: MouseEvent) {
      // The pane hangs from the bottom, so its share grows as the pointer
      // moves up — the inverse of the prose splitter's top-anchored math.
      const nextRatio = (rect.bottom - ev.clientY) / rect.height;
      setChatPaneRatio(Math.max(0.14, Math.min(0.75, nextRatio)));
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  useLayoutEffect(() => {
    if (chatPickerOpen) {
      // A fresh picker session: drop any pin left armed by a close that
      // never happened (e.g. the Use click's save failed), and pin the
      // transcript to its end so the generation's continuation point sits
      // just above the candidate pane (the chat analog of the prose
      // pinToLastLine-on-generate). This effect runs after the pane has
      // mounted, so the measurements already reflect the shrunken scroller.
      pinnedScrollBottomRef.current = null;
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight - el.clientHeight;
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
    <div className="bw-chat-workspace">
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
              const headNode = turn.nodes[0];
              const turnKey = headNode?.id ?? "";
              const draft = chatTurnDrafts[turnKey];
              const editable = turn.role === "user" || turn.role === "assistant";
              // The tail turn hosts the name editor for the node the path
              // currently ends on, which mid-turn is the latest partial-fill
              // chunk rather than the turn head. Earlier turns show carried
              // names read-only; renaming them means navigating there first.
              const editorNode =
                chatTailTurn === turn && chatTailNode && chatTailNode.parentId !== null
                  ? chatTailNode
                  : null;
              return (
                <section
                  key={`${turn.nodes[0]?.id ?? index}-${index}`}
                  className="bw-chat-turn"
                  data-role={turn.role}
                  data-active={isActiveAssistant}
                >
                  <div className="bw-chat-turn-head">
                    <span className="bw-chat-turn-head-left">
                      <span>{turn.role === "user" ? "YOU" : "ASSISTANT"}</span>
                      {turn.nodes.map((n) =>
                        n.name?.trim() && n.id !== editorNode?.id ? (
                          <span key={n.id} className="bw-chat-turn-name">
                            {n.name}
                          </span>
                        ) : null,
                      )}
                      {editorNode && (
                        <NodeNameEditor
                          node={editorNode}
                          disabled={saving || streaming}
                          placeholder="Name this node"
                          onRename={(name) =>
                            void onRenameChatNode(editorNode.id, name)
                          }
                        />
                      )}
                    </span>
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
                          // Deleting back to the snapshot dissolves the
                          // draft entirely. A clean draft left in the map
                          // would keep shadowing the turn's text, so a
                          // later mutation that extends the turn (using a
                          // generated candidate) would not show up until
                          // reload.
                          if (nextText === baseText) {
                            if (!existing) return current;
                            const next = { ...current };
                            delete next[turnKey];
                            return next;
                          }
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
                  <div className="bw-chat-turn-actions">
                    {isActiveAssistant && !branchPickerOpen && (
                      <button
                        type="button"
                        className="bw-button"
                        onClick={() => void onEndChatAssistantTurn()}
                        disabled={saving || streaming}
                      >
                        End turn
                      </button>
                    )}
                    {/* Every turn is deletable, including the in-progress
                        assistant tail — that's often exactly the block the
                        user wants gone (an abandoned generation or an empty
                        "Add assistant" chunk). */}
                    <button
                      type="button"
                      className="bw-button"
                      onClick={() => {
                        // Deleting under an open picker closes it (the
                        // candidates are stale); pin the scroll like the
                        // pane's own Use/Clear so the view doesn't jump.
                        if (chatPickerOpen) armScrollPin();
                        void onDeleteChatTurn(turn);
                      }}
                      disabled={saving || streaming}
                      title="Hide this turn and any later turns on the active path"
                    >
                      Delete
                    </button>
                  </div>
                </section>
              );
            })}

          {branchPickerOpen &&
            candidateContext === "chat" &&
            chatTailNode?.role !== "assistant" && (
              <section
                className="bw-chat-turn"
                data-role="assistant"
                data-active="true"
              >
                <div className="bw-chat-turn-head">
                  <span>ASSISTANT</span>
                  <span>in progress</span>
                </div>
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
      {chatPickerOpen && (
        <>
          <div
            className="bw-row-splitter"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize candidate pane"
            onMouseDown={startChatPaneDrag}
          />
          <section
            className="bw-chat-branch-pane"
            style={{ flexBasis: `${chatPaneRatio * 100}%` }}
            aria-label="Next chunk candidates"
          >
            {candidateCards}
          </section>
        </>
      )}
    </div>
  );
}
