import {
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";

import {
  mutateNodes,
  streamChatCompletion,
  type ChatCompletionMessage,
  type ProjectInfo,
  type SamplerBody,
  type TabbyModel,
} from "../api";
import { formatError } from "../errors";
import { mergePreset } from "../samplers/fields";
import { useBranchControls } from "../generation/useBranchControls";
import { useCandidates } from "../generation/useCandidates";
import { contextHash } from "../tree/hash";
import { branchNode, nodeId, nowEpoch } from "../tree/nodeFactory";
import { mutationBatchFromTrees } from "../tree/persistence";
import { concatPathText, pathFromRoot, type Tree, type TreeNode } from "../tree/types";
import {
  canAddAssistantChunkFromTail,
  canGenerateAssistantFromTail,
  commitChatDrafts,
  foldChatTurns,
  hasUnsavedChatDrafts,
  type ChatTurn,
  type ChatTurnDraft,
} from "./turns";

type ChatControllerDeps = {
  tree: Tree | null;
  currentId: string | null;
  project: ProjectInfo | null;
  currentPath: TreeNode[];
  saving: boolean;
  streaming: boolean;
  currentTabbyModel: TabbyModel | null;
  draftBody: SamplerBody;
  chatSystemDraft: string;
  chatUserDraft: string;
  chatTurnDrafts: Record<string, ChatTurnDraft>;
  setTree: Dispatch<SetStateAction<Tree | null>>;
  setCurrentId: Dispatch<SetStateAction<string | null>>;
  setBuffer: Dispatch<SetStateAction<string>>;
  setSaving: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setStreaming: Dispatch<SetStateAction<boolean>>;
  setChatSystemDraft: Dispatch<SetStateAction<string>>;
  setChatUserDraft: Dispatch<SetStateAction<string>>;
  setChatTurnDrafts: Dispatch<SetStateAction<Record<string, ChatTurnDraft>>>;
  candidates: ReturnType<typeof useCandidates>;
  branchControls: ReturnType<typeof useBranchControls>;
  abortRef: MutableRefObject<AbortController | null>;
  clearDeleteUndo: () => void;
  resetRecordedSelectionToEnd: (nextBuffer: string) => void;
};

/**
 * The chat workspace controller: the per-turn derived state plus every
 * generate / send / use / keep / end-turn / add-chunk / delete action. App owns
 * the tree, selection, draft, and candidate state and passes them in; this hook
 * threads them through chat/turns.ts and the streaming/persistence APIs and
 * hands back the derived flags and action callbacks for ChatSurface. The pure
 * turn-folding and draft logic lives in chat/turns.ts.
 */
export function useChatController(deps: ChatControllerDeps) {
  const {
    tree,
    currentId,
    project,
    currentPath,
    saving,
    streaming,
    currentTabbyModel,
    draftBody,
    chatSystemDraft,
    chatUserDraft,
    chatTurnDrafts,
    setTree,
    setCurrentId,
    setBuffer,
    setSaving,
    setError,
    setStreaming,
    setChatSystemDraft,
    setChatUserDraft,
    setChatTurnDrafts,
    branchControls,
    abortRef,
    clearDeleteUndo,
    resetRecordedSelectionToEnd,
  } = deps;
  const {
    candidates,
    candidateBaseId,
    candidatePrompt,
    candidateModelId,
    candidateSamplerSnapshot,
    savedCandidateIds,
    branchPickerOpen,
    setCandidates,
    setVisibleCandidateIndex,
    startGeneration,
    markKept,
    clearBranchPicker,
  } = deps.candidates;

  const pendingChatFocusRef = useRef<string | null>(null);

  const chatPathNodes = currentPath.filter((node) => node.parentId !== null);
  const chatTurns = useMemo<ChatTurn[]>(
    () => foldChatTurns(chatPathNodes),
    [chatPathNodes],
  );
  const chatSystemNode = chatPathNodes.find((node) => node.role === "system") ?? null;
  const chatTailNode = chatPathNodes[chatPathNodes.length - 1] ?? null;
  const chatTailTurn = chatTurns[chatTurns.length - 1] ?? null;
  const chatCanComposeUser =
    project?.kind === "chat" &&
    !branchPickerOpen &&
    (chatTailNode === null ||
      chatTailNode.role === "system" ||
      (chatTailNode.role === "assistant" && chatTailNode.endOfTurn));
  const chatCanGenerateAssistant =
    project?.kind === "chat" && canGenerateAssistantFromTail(chatTailNode);
  const chatCanAddAssistantChunk =
    project?.kind === "chat" && canAddAssistantChunkFromTail(chatTailNode);
  const chatHasPendingUserDraft = chatCanComposeUser && chatUserDraft.trim().length > 0;
  const chatCanSubmitOrGenerate = chatCanGenerateAssistant || chatHasPendingUserDraft;
  // True iff at least one chat turn draft or the system draft differs
  // from what's already persisted. Used both to enable the actionbar
  // Save button and to prompt before closing the project. Iterates the
  // full draft map (not just turns on the active path) so a draft the
  // user navigated away from still counts as unsaved.
  const chatHasUnsavedDrafts =
    project?.kind === "chat" &&
    hasUnsavedChatDrafts(tree, chatSystemNode, chatSystemDraft, chatTurnDrafts);

  useEffect(() => {
    if (project?.kind !== "chat") return;
    setChatSystemDraft(chatSystemNode?.text ?? "");
  }, [chatSystemNode?.id, chatSystemNode?.text, project?.kind, setChatSystemDraft]);

  useEffect(() => {
    const id = pendingChatFocusRef.current;
    if (!id) return;
    if (!chatTurns.some((turn) => turn.nodes[0]?.id === id)) return;
    if (saving || streaming) return;
    pendingChatFocusRef.current = null;
    const ta = document.querySelector<HTMLTextAreaElement>(
      `textarea[data-chat-node-id="${id}"]`,
    );
    if (ta) {
      ta.focus();
      const len = ta.value.length;
      ta.setSelectionRange(len, len);
    }
  }, [chatTurns, saving, streaming]);

  function buildChatPayload(path: TreeNode[]): {
    messages: ChatCompletionMessage[];
    responsePrefix: string | undefined;
  } {
    const turns = foldChatTurns(path.filter((item) => item.parentId !== null));

    const lastTurn = turns[turns.length - 1] ?? null;
    const continuingAssistant =
      lastTurn?.role === "assistant" && lastTurn.endOfTurn === false;
    const messageTurns = continuingAssistant ? turns.slice(0, -1) : turns;
    return {
      messages: messageTurns.map((turn) => ({
        role: turn.role,
        content: turn.text,
      })),
      responsePrefix: continuingAssistant ? lastTurn.text : undefined,
    };
  }

  async function persistChatTree(
    beforeTree: Tree,
    nextTree: Tree,
    nextCurrentId: string,
  ) {
    const nextBuffer = concatPathText(pathFromRoot(nextTree, nextCurrentId));
    setSaving(true);
    setError(null);
    try {
      await mutateNodes(mutationBatchFromTrees(beforeTree, nextTree, nextCurrentId));
      setTree(nextTree);
      setCurrentId(nextCurrentId);
      setBuffer(nextBuffer);
      resetRecordedSelectionToEnd(nextBuffer);
      clearDeleteUndo();
      return true;
    } catch (err) {
      setError(formatError(err));
      return false;
    } finally {
      setSaving(false);
    }
  }

  // Thin wrapper so the system editor's onBlur and Save button share
  // the same commit path as Cmd+S / actionbar Save. The system draft
  // is one of the inputs commitChatDrafts already knows how to
  // process — no bespoke tree-mutation needed here.
  async function onSaveChatSystem() {
    if (project?.kind !== "chat" || saving || streaming) return;
    await commitChatDraftsAndPersist();
  }

  // Commit every dirty chat draft (system + per-turn) in a single
  // round-trip and return the resulting tree/currentId, mirroring the
  // commitBuffer contract for prose. Returns null if persistence
  // failed; returns the input snapshot unchanged when nothing was
  // dirty. Callers that need to chain another mutation (Generate,
  // Send, Add assistant, navigation) call this first so the chain
  // operates on the freshly-committed tree.
  async function commitChatDraftsAndPersist(
    options: { preserveBranchPicker?: boolean } = {},
  ): Promise<{
    tree: Tree;
    currentId: string;
  } | null> {
    if (!tree || !currentId || project?.kind !== "chat") return null;
    if (saving || streaming) return null;

    const systemEdit =
      chatSystemNode && chatSystemDraft !== chatSystemNode.text
        ? { nodeId: chatSystemNode.id, text: chatSystemDraft }
        : null;
    const result = commitChatDrafts(
      tree,
      currentId,
      chatTurns,
      chatTurnDrafts,
      systemEdit,
      { newNodeId: nodeId, now: nowEpoch, contextHash },
    );

    // Dirty-but-uncommitable drafts (e.g. a turn the user emptied)
    // would otherwise vanish silently. Surface a user-facing error
    // and abort the commit so the source of the dirty state is
    // visible; the user can type something, revert with Escape, or
    // navigate to a different branch.
    if (result.skippedTurnDraftIds.length > 0) {
      setError(
        "Some chat turns are empty and can't be saved. Type something or press Escape to discard.",
      );
      return null;
    }

    if (result.tree === tree && result.currentId === currentId) {
      // Even with no tree change a draft can be reverted-to-clean —
      // those become no-ops here; nothing to evict.
      return { tree, currentId };
    }

    setSaving(true);
    setError(null);
    try {
      await mutateNodes(mutationBatchFromTrees(tree, result.tree, result.currentId));
      setTree(result.tree);
      setCurrentId(result.currentId);
      setBuffer(concatPathText(pathFromRoot(result.tree, result.currentId)));
      clearDeleteUndo();
      // Evict only the drafts we actually consumed. The wholesale
      // wipe used to drop any unsaved off-path / sibling-branch
      // drafts on every commit, including the cleanest no-op.
      if (result.consumedTurnDraftIds.length > 0) {
        setChatTurnDrafts((current) => {
          const next = { ...current };
          for (const id of result.consumedTurnDraftIds) delete next[id];
          return next;
        });
      }
      // Most callers want the picker closed after any tree-changing
      // commit (the candidates were generated against a now-stale
      // path). Keep is the exception: it's explicitly a "save this
      // one, leave the rest visible" action, so it opts out.
      if (!options.preserveBranchPicker) clearBranchPicker();
      return { tree: result.tree, currentId: result.currentId };
    } catch (err) {
      setError(formatError(err));
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function startChatAssistantGeneration(baseTree = tree, baseId = currentId) {
    if (!baseTree || !baseId || streaming) return;
    if (!currentTabbyModel) {
      setError("Load a model before generating.");
      return;
    }

    const basePath = pathFromRoot(baseTree, baseId);
    const tail = basePath[basePath.length - 1] ?? null;
    if (
      !tail ||
      (tail.role !== "user" && !(tail.role === "assistant" && !tail.endOfTurn))
    ) {
      setError("Submit a user turn before generating an assistant response.");
      return;
    }

    const n = branchControls.normalizeBranchCount();
    if (n === null) return;
    const resolvedMaxTokens = branchControls.normalizeMaxTokens();
    const samplerSnapshot = mergePreset(draftBody);
    const promptSnapshot = concatPathText(basePath);
    const { messages, responsePrefix } = buildChatPayload(basePath);

    startGeneration({
      context: "chat",
      count: n,
      prompt: promptSnapshot,
      baseId,
      modelId: currentTabbyModel.id,
      samplerSnapshot,
    });
    setError(null);
    setStreaming(true);
    abortRef.current = new AbortController();
    let firstVisibleChosen = false;

    try {
      await streamChatCompletion(
        {
          messages,
          response_prefix: responsePrefix,
          add_generation_prompt: true,
          n,
          max_tokens: resolvedMaxTokens,
          ...samplerSnapshot,
        },
        (chunk) => {
          for (const choice of chunk.choices) {
            if (choice.index < 0 || choice.index >= n) continue;
            const text = choice.delta.content ?? "";
            if (!firstVisibleChosen && text) {
              firstVisibleChosen = true;
              setVisibleCandidateIndex(choice.index);
            }
            setCandidates((current) => {
              const next =
                current.length === n
                  ? [...current]
                  : Array.from(
                      { length: n },
                      (_, index) =>
                        current[index] ?? {
                          text: "",
                          done: false,
                          finishReason: null,
                        },
                    );
              const existing = next[choice.index] ?? {
                text: "",
                done: false,
                finishReason: null,
              };
              next[choice.index] = {
                text: existing.text + text,
                done: existing.done || choice.finish_reason !== null,
                finishReason: choice.finish_reason ?? existing.finishReason,
              };
              return next;
            });
          }
        },
        abortRef.current.signal,
      );
    } catch (err) {
      const e = err as Error;
      if (e.name !== "AbortError") setError(e.message);
    } finally {
      setCandidates((current) =>
        current.map((candidate) => ({ ...candidate, done: true })),
      );
      setStreaming(false);
      abortRef.current = null;
    }
  }

  async function onSubmitChatUser() {
    if (!tree || !currentId || project?.kind !== "chat" || saving || streaming) return;
    const text = chatUserDraft;
    if (!text.trim()) return;

    // Flush any pending turn / system edits first so this new turn
    // attaches to the freshly-committed tree, not a stale snapshot.
    const committed = await commitChatDraftsAndPersist();
    if (!committed) return;
    const { tree: workingTree, currentId: workingId } = committed;
    if (!workingTree.nodes[workingId]) return;

    const priorText = concatPathText(pathFromRoot(workingTree, workingId));
    const node: TreeNode = {
      id: nodeId(),
      parentId: workingId,
      text,
      name: null,
      source: "user_written",
      role: "user",
      endOfTurn: true,
      hidden: false,
      deleted: false,
      starred: false,
      createdAt: nowEpoch(),
      priorContextHash: contextHash(priorText),
    };
    const nextTree: Tree = {
      rootId: workingTree.rootId,
      nodes: {
        ...workingTree.nodes,
        [node.id]: node,
      },
    };
    const saved = await persistChatTree(workingTree, nextTree, node.id);
    if (!saved) return;
    setChatUserDraft("");
    void startChatAssistantGeneration(nextTree, node.id);
  }

  async function onDeleteChatTurn(turn: ChatTurn) {
    if (!tree || !currentId || project?.kind !== "chat" || saving || streaming) return;
    const firstNode = turn.nodes[0];
    if (!firstNode || firstNode.parentId === null) return;
    const turnStart = chatPathNodes.findIndex((node) => node.id === firstNode.id);
    if (turnStart < 0) return;
    const toHide = chatPathNodes.slice(turnStart);
    if (toHide.length === 0) return;
    const nextNodes: Record<string, TreeNode> = { ...tree.nodes };
    for (const node of toHide) {
      nextNodes[node.id] = { ...node, hidden: true };
    }
    const nextTree: Tree = { rootId: tree.rootId, nodes: nextNodes };
    setChatTurnDrafts((current) => {
      const next = { ...current };
      for (const node of toHide) delete next[node.id];
      return next;
    });
    await persistChatTree(tree, nextTree, firstNode.parentId);
  }

  async function onUseChatCandidate(index: number) {
    if (
      !tree ||
      !currentId ||
      candidateBaseId === null ||
      candidatePrompt === null ||
      saving ||
      streaming
    ) {
      return;
    }
    const text = candidates[index]?.text ?? "";
    if (!text) {
      setError("Select a branch with text before using it.");
      return;
    }
    // Flush any pending turn / system edits first so the candidate
    // attaches to the freshly-committed tree, not a stale snapshot.
    // Without this an edit-in-progress on an earlier turn would be
    // silently dropped by the next save.
    const committed = await commitChatDraftsAndPersist();
    if (!committed) return;
    const base = committed.tree.nodes[candidateBaseId];
    if (!base) {
      setError("The generation base no longer exists.");
      return;
    }
    // If the flush forked the turn the candidate was generated
    // against, candidateBaseId still exists — but as a sibling on
    // the abandoned branch. Attaching the chosen candidate there
    // would orphan it off the active path. Bail with a clear
    // message instead of silently producing dead text.
    const committedPathIds = new Set(
      pathFromRoot(committed.tree, committed.currentId).map((node) => node.id),
    );
    if (!committedPathIds.has(candidateBaseId)) {
      setError(
        "Saving your edit changed the generation base. Regenerate to attach a candidate to the new path.",
      );
      clearBranchPicker();
      return;
    }
    const endOfTurn = candidates[index]?.finishReason === "stop";
    const node = branchNode(
      candidateBaseId,
      text,
      "composed",
      false,
      candidatePrompt,
      candidateModelId ?? undefined,
      candidateSamplerSnapshot ?? undefined,
      "assistant",
      endOfTurn,
    );
    const nextTree: Tree = {
      rootId: committed.tree.rootId,
      nodes: {
        ...committed.tree.nodes,
        [node.id]: node,
      },
    };
    const saved = await persistChatTree(committed.tree, nextTree, node.id);
    if (saved) clearBranchPicker();
  }

  async function onKeepChatCandidate(index: number) {
    if (
      !tree ||
      !currentId ||
      candidateBaseId === null ||
      candidatePrompt === null ||
      saving ||
      savedCandidateIds[index]
    ) {
      return;
    }
    const text = candidates[index]?.text ?? "";
    if (!text) {
      setError("Select a branch with text before keeping it.");
      return;
    }
    // Same draft-flush rationale as onUseChatCandidate. Keep
    // preserves the picker because the whole point of Keep is to
    // save one candidate while leaving the others visible for
    // continued evaluation.
    const committed = await commitChatDraftsAndPersist({ preserveBranchPicker: true });
    if (!committed) return;
    if (!committed.tree.nodes[candidateBaseId]) {
      setError("The generation base no longer exists.");
      return;
    }
    // Same path-validity check as Use: a flush that forked the
    // base turn moved candidateBaseId off the active path. Keep's
    // saved branch would dangle under the abandoned chain.
    const committedPathIds = new Set(
      pathFromRoot(committed.tree, committed.currentId).map((node) => node.id),
    );
    if (!committedPathIds.has(candidateBaseId)) {
      setError(
        "Saving your edit changed the generation base. Regenerate to keep a candidate against the new path.",
      );
      clearBranchPicker();
      return;
    }
    const node = branchNode(
      candidateBaseId,
      text,
      "generated",
      true,
      candidatePrompt,
      candidateModelId ?? undefined,
      candidateSamplerSnapshot ?? undefined,
      "assistant",
      candidates[index]?.finishReason === "stop",
    );
    const nextTree: Tree = {
      rootId: committed.tree.rootId,
      nodes: {
        ...committed.tree.nodes,
        [node.id]: node,
      },
    };
    setSaving(true);
    setError(null);
    try {
      await mutateNodes(
        mutationBatchFromTrees(committed.tree, nextTree, committed.currentId),
      );
      setTree(nextTree);
      markKept(index, node.id);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSaving(false);
    }
  }

  async function onEndChatAssistantTurn() {
    if (!tree || !currentId || !chatTailNode || saving || streaming) return;
    if (chatTailNode.role !== "assistant" || chatTailNode.endOfTurn) return;
    const nextTree: Tree = {
      rootId: tree.rootId,
      nodes: {
        ...tree.nodes,
        [chatTailNode.id]: {
          ...chatTailNode,
          endOfTurn: true,
        },
      },
    };
    await persistChatTree(tree, nextTree, currentId);
  }

  // Append an empty assistant chunk the user can type into directly,
  // bypassing the model. The chunk is non-final (endOfTurn=false) so
  // they can keep extending it or click "End turn" when done.
  async function onAddChatAssistantChunk() {
    if (!tree || !currentId || project?.kind !== "chat" || saving || streaming) return;
    if (!chatCanAddAssistantChunk) return;

    const committed = await commitChatDraftsAndPersist();
    if (!committed) return;
    const { tree: workingTree, currentId: workingId } = committed;

    const priorText = concatPathText(pathFromRoot(workingTree, workingId));
    const node: TreeNode = {
      id: nodeId(),
      parentId: workingId,
      text: "",
      name: null,
      source: "user_written",
      role: "assistant",
      endOfTurn: false,
      hidden: false,
      deleted: false,
      starred: false,
      createdAt: nowEpoch(),
      priorContextHash: contextHash(priorText),
    };
    const nextTree: Tree = {
      rootId: workingTree.rootId,
      nodes: {
        ...workingTree.nodes,
        [node.id]: node,
      },
    };
    clearBranchPicker();
    pendingChatFocusRef.current = node.id;
    const saved = await persistChatTree(workingTree, nextTree, node.id);
    // If persistence failed the node never made it into the tree —
    // clearing the focus intent so the effect doesn't sit armed
    // forever, ready to focus a phantom id (or worse, accidentally
    // focus an unrelated turn that later coincidentally shares the
    // id).
    if (!saved) pendingChatFocusRef.current = null;
  }

  return {
    chatPathNodes,
    chatTurns,
    chatSystemNode,
    chatTailNode,
    chatTailTurn,
    chatCanComposeUser,
    chatCanGenerateAssistant,
    chatCanAddAssistantChunk,
    chatHasPendingUserDraft,
    chatCanSubmitOrGenerate,
    chatHasUnsavedDrafts,
    onSaveChatSystem,
    commitChatDraftsAndPersist,
    startChatAssistantGeneration,
    onSubmitChatUser,
    onDeleteChatTurn,
    onUseChatCandidate,
    onKeepChatCandidate,
    onEndChatAssistantTurn,
    onAddChatAssistantChunk,
  };
}
