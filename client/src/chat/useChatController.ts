import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
} from "react";

import {
  beginTreeMutation,
  endTreeMutation,
  mutateNodes,
  streamChatCompletion,
  type ChatCompletionMessage,
  type ProjectInfo,
  type SamplerBody,
  type TabbyModel,
} from "../api";
import { formatError } from "../errors";
import {
  appendToCandidate,
  foldChunk,
  seededCandidates,
  usableCandidateText,
} from "../candidates";
import {
  buildSamplerSnapshot,
  clampMinTokens,
  fetchChatOpenings,
  runSeededFanOut,
  SEEDED_BRANCH_CAP,
} from "../generation/seeding";
import { useBranchControls } from "../generation/useBranchControls";
import { useCandidates } from "../generation/useCandidates";
import { contextHash } from "../tree/hash";
import { branchNode, nodeId, nowEpoch } from "../tree/nodeFactory";
import { mutationBatchFromTrees } from "../tree/persistence";
import { treeHistoryLocation, type RecordTreeHistory } from "../tree/history";
import type { WorkspaceAction } from "../workspace/workspaceReducer";
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

type ChatTreeHistory =
  | { kind: "entry"; label: string }
  | { kind: "boundary"; label: string; reason: string };

type ChatControllerDeps = {
  tree: Tree | null;
  currentId: string | null;
  mapSelectedId: string | null;
  mapSelectionIds: string[];
  project: ProjectInfo | null;
  currentPath: TreeNode[];
  saving: boolean;
  streaming: boolean;
  currentTabbyModel: TabbyModel | null;
  draftBody: SamplerBody;
  dispatch: Dispatch<WorkspaceAction>;
  candidates: ReturnType<typeof useCandidates>;
  branchControls: ReturnType<typeof useBranchControls>;
  /** Project ban list to send, already gated by its master switch. */
  activeBannedStrings: string[];
  abortRef: MutableRefObject<AbortController | null>;
  recordTreeHistory: RecordTreeHistory;
  recordTreeHistoryBoundary: (label: string, reason: string) => void;
  resetRecordedSelectionToEnd: (nextBuffer: string) => void;
};

/**
 * The chat workspace controller: the per-turn derived state plus every
 * generate / send / use / keep / end-turn / add-chunk / delete action. App owns
 * the tree/selection state in a reducer and passes the reads in with its
 * dispatch; this hook threads them through chat/turns.ts and the
 * streaming/persistence APIs and hands back the derived flags and action
 * callbacks for ChatSurface. The pure turn-folding and draft logic lives in
 * chat/turns.ts.
 */
export function useChatController(deps: ChatControllerDeps) {
  const {
    tree,
    currentId,
    mapSelectedId,
    mapSelectionIds,
    project,
    currentPath,
    saving,
    streaming,
    currentTabbyModel,
    draftBody,
    dispatch,
    branchControls,
    activeBannedStrings,
    abortRef,
    recordTreeHistory,
    recordTreeHistoryBoundary,
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

  // Thin adapters over the workspace dispatch for the per-field flag/error
  // updates this hook makes; the coupled persist clusters below dispatch the
  // semantic bufferReshaped / treeMutated actions directly.
  const setSaving = (value: boolean) => dispatch({ type: "setSaving", value });
  const setStreaming = (value: boolean) => dispatch({ type: "setStreaming", value });
  const setError = (value: string | null) => dispatch({ type: "setError", value });

  const [chatSystemDraft, setChatSystemDraft] = useState("");
  const [chatUserDraft, setChatUserDraft] = useState("");
  const [chatTurnDrafts, setChatTurnDrafts] = useState<Record<string, ChatTurnDraft>>(
    {},
  );
  const [chatSystemExpanded, setChatSystemExpanded] = useState(false);

  // Clear every chat draft back to empty. Called when a project opens or
  // closes. On a chat open the init effect below immediately re-initializes
  // chatSystemDraft from the active system node; clearing it here first
  // covers the close / prose-project cases where that effect's chat guard
  // keeps it from running.
  const resetChatDrafts = useCallback(() => {
    setChatUserDraft("");
    setChatTurnDrafts({});
    setChatSystemExpanded(false);
    setChatSystemDraft("");
  }, []);

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

  // Initialize the editable system-prompt draft from the active system node.
  // This is the single initializer for chatSystemDraft: it fires on chat open
  // and whenever the active system node changes (e.g. switching branches).
  // resetChatDrafts clears the draft for the close / prose-project cases.
  useEffect(() => {
    if (project?.kind !== "chat") return;
    setChatSystemDraft(chatSystemNode?.text ?? "");
  }, [chatSystemNode?.id, chatSystemNode?.text, project?.kind]);

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
    beforeCurrentId: string,
    nextTree: Tree,
    nextCurrentId: string,
    options: { history: ChatTreeHistory },
  ) {
    if (!beginTreeMutation()) return false;
    const nextBuffer = concatPathText(pathFromRoot(nextTree, nextCurrentId));
    setSaving(true);
    setError(null);
    try {
      await mutateNodes(mutationBatchFromTrees(beforeTree, nextTree, nextCurrentId));
      dispatch({
        type: "bufferReshaped",
        tree: nextTree,
        currentId: nextCurrentId,
        buffer: nextBuffer,
      });
      resetRecordedSelectionToEnd(nextBuffer);
      if (options.history.kind === "entry") {
        recordTreeHistory({
          label: options.history.label,
          beforeTree,
          afterTree: nextTree,
          beforeLocation: treeHistoryLocation(
            beforeTree,
            beforeCurrentId,
            mapSelectedId,
            mapSelectionIds,
          ),
          afterLocation: treeHistoryLocation(
            nextTree,
            nextCurrentId,
            mapSelectedId,
            mapSelectionIds,
          ),
        });
      } else if (options.history.kind === "boundary") {
        recordTreeHistoryBoundary(options.history.label, options.history.reason);
      }
      return true;
    } catch (err) {
      setError(formatError(err));
      return false;
    } finally {
      setSaving(false);
      endTreeMutation();
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

    if (!beginTreeMutation()) return null;
    setSaving(true);
    setError(null);
    try {
      await mutateNodes(mutationBatchFromTrees(tree, result.tree, result.currentId));
      dispatch({
        type: "bufferReshaped",
        tree: result.tree,
        currentId: result.currentId,
        buffer: concatPathText(pathFromRoot(result.tree, result.currentId)),
      });
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
      endTreeMutation();
    }
  }

  async function startChatAssistantGeneration(baseTree = tree, baseId = currentId) {
    if (!baseTree || !baseId || streaming) return;
    if (!currentTabbyModel) {
      setError("Load a model before generating.");
      return;
    }

    let workingTree = baseTree;
    let basePath = pathFromRoot(workingTree, baseId);
    const tail = basePath[basePath.length - 1] ?? null;
    if (!tail || (tail.role !== "user" && tail.role !== "assistant")) {
      setError("Submit a user turn before generating an assistant response.");
      return;
    }

    // Generating from a finalized assistant tail means "continue this turn
    // after all": re-open it (persist endOfTurn=false) before building the
    // payload, so the prompt treats the turn text as a response prefix and
    // the accepted chunk folds into the same turn rather than starting a
    // second assistant message.
    if (tail.role === "assistant" && tail.endOfTurn) {
      const reopenedTree: Tree = {
        rootId: workingTree.rootId,
        nodes: {
          ...workingTree.nodes,
          [tail.id]: { ...tail, endOfTurn: false },
        },
      };
      const saved = await persistChatTree(workingTree, baseId, reopenedTree, baseId, {
        history: { kind: "entry", label: "Continue assistant turn" },
      });
      if (!saved) return;
      workingTree = reopenedTree;
      basePath = pathFromRoot(workingTree, baseId);
    }

    const n = branchControls.normalizeBranchCount();
    if (n === null) return;
    const resolvedMaxTokens = branchControls.normalizeMaxTokens();
    // Resolve the sampler snapshot now, with the active project bans folded in,
    // so a drawer or ban-list edit mid-stream can't change what a persisted node
    // records as having produced it, and a saved node carries the bans that
    // actually shaped its text. The snapshot and the request body are the same.
    const samplerSnapshot = buildSamplerSnapshot(draftBody, activeBannedStrings);
    const promptSnapshot = concatPathText(basePath);
    const { messages, responsePrefix } = buildChatPayload(basePath);

    setError(null);
    setStreaming(true);
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    try {
      // Diverse openings. Probe a pool of first-token candidates, sample one
      // opening per branch from it, then fan out one continuation per opening
      // so siblings start differently. The seed token rides in response_prefix,
      // so it never streams back. The helper pre-seeds each slot with it. The
      // helper returns false when the probe yields no usable pool, so the plain
      // n-sample path below runs instead.
      let ranSeeded = false;
      if (branchControls.seededBranches) {
        // Cap the seeded branch count at the browser's connection limit so every
        // branch streams at once. See SEEDED_BRANCH_CAP. The plain path below is
        // one request, so it keeps the user's full count.
        const seededCount = Math.min(n, SEEDED_BRANCH_CAP);
        ranSeeded = await runSeededFanOut({
          resolvedMaxTokens,
          signal,
          clearBranchPicker,
          bannedStrings: activeBannedStrings,
          seedCount: seededCount,
          samplerBody: samplerSnapshot,
          fetchOpenings: (probeSignal, prefixText) =>
            fetchChatOpenings(
              {
                messages,
                // Deeper probes carry the grown seed text in the response
                // prefix, the same way the continuations carry their seed.
                response_prefix: prefixText
                  ? (responsePrefix ?? "") + prefixText
                  : responsePrefix,
                add_generation_prompt: true,
                ...samplerSnapshot,
              },
              probeSignal,
            ),
          beginSeeded: (seeds) => {
            startGeneration({
              context: "chat",
              count: seeds.length,
              prompt: promptSnapshot,
              baseId,
              modelId: currentTabbyModel.id,
              samplerSnapshot,
            });
            setCandidates(seededCandidates(seeds));
            setVisibleCandidateIndex(0);
          },
          streamSeed: (seed, slot, continuationMax, seedSignal) =>
            streamChatCompletion(
              clampMinTokens(
                {
                  messages,
                  response_prefix: (responsePrefix ?? "") + seed,
                  add_generation_prompt: true,
                  n: 1,
                  max_tokens: continuationMax,
                  ...samplerSnapshot,
                },
                continuationMax,
              ),
              (chunk) => {
                for (const choice of chunk.choices) {
                  const text = choice.delta.content ?? "";
                  if (!text && choice.finish_reason === null) continue;
                  setCandidates((current) =>
                    appendToCandidate(current, slot, text, choice.finish_reason),
                  );
                }
              },
              seedSignal,
            ),
          setCandidates,
          setError,
        });
      }

      if (!ranSeeded) {
        startGeneration({
          context: "chat",
          count: n,
          prompt: promptSnapshot,
          baseId,
          modelId: currentTabbyModel.id,
          samplerSnapshot,
        });
        let firstVisibleChosen = false;
        await streamChatCompletion(
          clampMinTokens(
            {
              messages,
              response_prefix: responsePrefix,
              add_generation_prompt: true,
              n,
              max_tokens: resolvedMaxTokens,
              ...samplerSnapshot,
            },
            resolvedMaxTokens,
          ),
          (chunk) => {
            for (const choice of chunk.choices) {
              if (choice.index < 0 || choice.index >= n) continue;
              const text = choice.delta.content ?? "";
              if (!firstVisibleChosen && text) {
                firstVisibleChosen = true;
                setVisibleCandidateIndex(choice.index);
              }
              setCandidates((current) =>
                foldChunk(current, choice.index, text, choice.finish_reason, n),
              );
            }
          },
          signal,
        );
      }
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

  // Build the persisted turn node for the composer's pending user
  // message. Shared by Send (which follows with a generation) and
  // Save (which stops after the persist).
  function buildUserTurnNode(
    workingTree: Tree,
    workingId: string,
    text: string,
  ): TreeNode {
    const priorText = concatPathText(pathFromRoot(workingTree, workingId));
    return {
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
  }

  // Persist the composer's pending user message as a turn without
  // starting a generation. Returns the new tree/currentId, the input
  // snapshot when there is no pending message, or null on failure.
  async function persistPendingUserDraft(
    committed: { tree: Tree; currentId: string },
    boundaryLabel: string,
  ): Promise<{ tree: Tree; currentId: string } | null> {
    const text = chatUserDraft;
    if (!chatCanComposeUser || !text.trim()) return committed;
    const { tree: workingTree, currentId: workingId } = committed;
    if (!workingTree.nodes[workingId]) return committed;

    const node = buildUserTurnNode(workingTree, workingId, text);
    const nextTree: Tree = {
      rootId: workingTree.rootId,
      nodes: {
        ...workingTree.nodes,
        [node.id]: node,
      },
    };
    const saved = await persistChatTree(workingTree, workingId, nextTree, node.id, {
      history: {
        kind: "boundary",
        label: boundaryLabel,
        reason: "Saved messages are edited or deleted explicitly.",
      },
    });
    if (!saved) return null;
    setChatUserDraft("");
    return { tree: nextTree, currentId: node.id };
  }

  // The chat Save action (actionbar button and Cmd+S). Flushes every
  // dirty turn / system draft, then also ships a pending composer
  // message as a user turn so a first message typed into a fresh
  // workbook saves before any generate happens.
  async function onSaveChat(): Promise<{ tree: Tree; currentId: string } | null> {
    const committed = await commitChatDraftsAndPersist();
    if (!committed) return null;
    return persistPendingUserDraft(committed, "Saved chat message");
  }

  async function onSubmitChatUser() {
    if (!tree || !currentId || project?.kind !== "chat" || saving || streaming) return;
    if (!chatUserDraft.trim()) return;

    // Flush any pending turn / system edits first so this new turn
    // attaches to the freshly-committed tree, not a stale snapshot.
    const committed = await commitChatDraftsAndPersist();
    if (!committed) return;
    const result = await persistPendingUserDraft(committed, "Submitted chat message");
    if (!result || result === committed) return;
    void startChatAssistantGeneration(result.tree, result.currentId);
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
    const saved = await persistChatTree(tree, currentId, nextTree, firstNode.parentId, {
      history: { kind: "entry", label: "Delete chat turn" },
    });
    // Once the turn is persistently hidden, candidates generated against its
    // old path are stale. A failed delete leaves both the path and picker
    // untouched so the user can retry without losing either drafts or results.
    if (saved) {
      setChatTurnDrafts((current) => {
        const next = { ...current };
        for (const node of toHide) delete next[node.id];
        return next;
      });
      clearBranchPicker();
    }
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
    const text = usableCandidateText(candidates[index], "using", setError);
    if (text === null) return;
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
    const saved = await persistChatTree(
      committed.tree,
      committed.currentId,
      nextTree,
      node.id,
      {
        history: { kind: "entry", label: "Use chat candidate" },
      },
    );
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
    const text = usableCandidateText(candidates[index], "keeping", setError);
    if (text === null) return;

    // Keep stays available while sibling branches are still streaming, so a
    // finished candidate can be saved without waiting for the whole pass. The
    // draft flush mutates the tree, which commitChatDraftsAndPersist refuses to
    // do mid-stream, so while streaming we attach the kept branch straight onto
    // the current tree. candidateBaseId is the live generation base, so it is
    // always on the current path then. With nothing streaming we flush pending
    // drafts first so the kept branch attaches to the freshly committed tree.
    // Keep preserves the picker either way because its whole point is to save
    // one candidate while leaving the others visible.
    let baseTree = tree;
    let baseCurrentId = currentId;
    if (!streaming) {
      const committed = await commitChatDraftsAndPersist({
        preserveBranchPicker: true,
      });
      if (!committed) return;
      baseTree = committed.tree;
      baseCurrentId = committed.currentId;
    }
    if (!baseTree.nodes[candidateBaseId]) {
      setError("The generation base no longer exists.");
      return;
    }
    // A flush that forked the base turn moved candidateBaseId off the active
    // path, where Keep's saved branch would dangle under the abandoned chain.
    // No flush runs mid-stream, so this only trips after a draft commit.
    const committedPathIds = new Set(
      pathFromRoot(baseTree, baseCurrentId).map((node) => node.id),
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
      rootId: baseTree.rootId,
      nodes: {
        ...baseTree.nodes,
        [node.id]: node,
      },
    };
    if (!beginTreeMutation()) return;
    setSaving(true);
    setError(null);
    try {
      await mutateNodes(mutationBatchFromTrees(baseTree, nextTree, baseCurrentId));
      dispatch({ type: "treeMutated", tree: nextTree });
      recordTreeHistory({
        label: "Keep chat candidate",
        beforeTree: baseTree,
        afterTree: nextTree,
        beforeLocation: treeHistoryLocation(
          baseTree,
          baseCurrentId,
          mapSelectedId,
          mapSelectionIds,
        ),
        afterLocation: treeHistoryLocation(
          nextTree,
          baseCurrentId,
          mapSelectedId,
          mapSelectionIds,
        ),
      });
      markKept(index, node.id);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSaving(false);
      endTreeMutation();
    }
  }

  async function onEndChatAssistantTurn() {
    if (!tree || !currentId || !chatTailNode || saving || streaming) return;
    if (chatTailNode.role !== "assistant" || chatTailNode.endOfTurn) return;
    // Flush the draft text typed into the chunk first. Without this
    // the turn finalizes with the stale persisted text (often empty
    // for a fresh "Add assistant" chunk) and a reload would drop
    // what the user wrote.
    const committed = await commitChatDraftsAndPersist();
    if (!committed) return;
    const tail = committed.tree.nodes[committed.currentId];
    if (!tail || tail.role !== "assistant" || tail.endOfTurn) return;
    const nextTree: Tree = {
      rootId: committed.tree.rootId,
      nodes: {
        ...committed.tree.nodes,
        [tail.id]: {
          ...tail,
          endOfTurn: true,
        },
      },
    };
    await persistChatTree(
      committed.tree,
      committed.currentId,
      nextTree,
      committed.currentId,
      {
        history: { kind: "entry", label: "End assistant turn" },
      },
    );
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
    const saved = await persistChatTree(workingTree, workingId, nextTree, node.id, {
      history: { kind: "entry", label: "Add assistant chunk" },
    });
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
    chatSystemDraft,
    setChatSystemDraft,
    chatUserDraft,
    setChatUserDraft,
    chatTurnDrafts,
    setChatTurnDrafts,
    chatSystemExpanded,
    setChatSystemExpanded,
    resetChatDrafts,
    onSaveChatSystem,
    onSaveChat,
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
