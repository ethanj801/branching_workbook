import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type SetStateAction,
} from "react";
import {
  closeProject as closeProjectApi,
  createProject,
  createPreset,
  currentProject,
  deletePreset,
  dialogPickNewProject,
  dialogPickProject,
  encodeTokens,
  getActivePreset,
  getProjectSettings,
  listNodes,
  listPresets,
  beginTreeMutation,
  endTreeMutation,
  mutateNodes,
  openProject,
  setActivePreset,
  streamCompletion,
  updateProjectSettings,
  updatePreset,
  type ComposeDisplayMode,
  type DialogResult,
  type ProjectInfo,
  type ProjectSettingsPatch,
  type SamplerBody,
  type SamplerPreset,
  type TabbyModel,
} from "./api";
import type { KeyBinding } from "@codemirror/view";
import WorkbookEditor, {
  type EditorSelection,
  type WorkbookEditorHandle,
} from "./editor/WorkbookEditor";
import SamplerDrawer from "./samplers/SamplerDrawer";
import { neutralBody } from "./samplers/fields";
import { useModelLoader, type ModelDownloadJob } from "./models/useModelLoader";
import ModelPanel from "./models/ModelPanel";
import NodeMapView from "./nodemap/NodeMapView";
import Switch from "./Switch";
import InfoDot from "./InfoDot";
import {
  appendToCandidate,
  applyChoice,
  seededCandidates,
  usableCandidateText,
} from "./candidates";
import {
  buildSamplerSnapshot,
  clampMinTokens,
  fetchProseOpenings,
  runSeededFanOut,
  SEEDED_BRANCH_CAP,
} from "./generation/seeding";
import {
  MAX_BRANCH_UI_LIMIT,
  branchGridColumns,
  maxBranchesForModel,
  resolveTokensPerSuggestion,
} from "./generation/branchControls";
import { useBranchControls } from "./generation/useBranchControls";
import { useBanList } from "./banlist/useBanList";
import BanListPopover from "./banlist/BanListPopover";
import { useCandidates } from "./generation/useCandidates";
import BranchPicker from "./generation/BranchPicker";
import InlineCandidateControls from "./generation/InlineCandidateControls";
import { useLatestRef } from "./useLatestRef";
import { formatError } from "./errors";
import { initialWorkspaceState, workspaceReducer } from "./workspace/workspaceReducer";
import ChatSurface from "./chat/ChatSurface";
import {
  buildChatTranscriptWithDrafts,
  chatTranscriptFilename,
  downloadTextFile,
} from "./chat/exportTranscript";
import { useChatController } from "./chat/useChatController";
import TreeSidebar from "./sidebar/TreeSidebar";
import { branchNode, nodeId, nowEpoch } from "./tree/nodeFactory";
import { loadedTreeFromModels, mutationBatchFromTrees } from "./tree/persistence";
import { reshape } from "./tree/reshape";
import {
  analyzeNodeMapMergeSelection,
  buildMergedSelectionTree,
  buildMergedTree,
  collectLinearChainDownward,
  collectSubtreeNodeIds,
} from "./tree/merge";
import {
  childrenOf,
  concatPathText,
  pathFromRoot,
  type NodeSource,
  type Tree,
  type TreeNode,
} from "./tree/types";

type CommitResult = {
  tree: Tree;
  currentId: string;
  buffer: string;
};

type TreeContextMenu = {
  nodeId: string;
  x: number;
  y: number;
};

type WorkspaceMode = "compose" | "autocomplete" | "map";

const DIVERSE_OPENINGS_INFO =
  "Start each branch from a different token so siblings diverge instead of repeating the same opening.";

type AutocompleteState =
  | { phase: "idle" }
  | { phase: "thinking" }
  | { phase: "showing"; suggestions: string[]; visibleIdx: number };

// Triggered when the server's native dialog endpoint isn't available
// (off-macOS); the user types a project path into a fallback modal.
type ManualPathRequest = { mode: "open" } | { mode: "create"; kind: "prose" | "chat" };

// Shallow structural equality for two sampler bodies: same key set, each value
// JSON-equal. JSON.stringify is key-order-sensitive for nested objects, so this
// assumes flat bodies (sampler params are scalars) — true today. Recomputed on
// every draftDirty check (per keystroke), which is fine at this size.
function bodiesEqual(a: SamplerBody, b: SamplerBody): boolean {
  const keysA = Object.keys(a) as (keyof SamplerBody)[];
  const keysB = Object.keys(b) as (keyof SamplerBody)[];
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false;
  }
  return true;
}

function modelContextMax(model: TabbyModel | null): number | null {
  return model?.parameters?.max_seq_len ?? null;
}

function formatModelLabel(model: TabbyModel | null): string {
  if (!model) return "No model loaded";
  const maxSeqLen = modelContextMax(model);
  const cacheMode = model.parameters?.cache_mode;
  const suffix = [maxSeqLen ? `${maxSeqLen.toLocaleString()} ctx` : null, cacheMode]
    .filter(Boolean)
    .join(" / ");
  return suffix ? `${model.id} (${suffix})` : model.id;
}

function formatModelDownloadStatus(job: ModelDownloadJob): string {
  switch (job.phase) {
    case "downloading":
      return `Downloading ${job.modelName}`;
    case "completed":
      return `Downloaded ${job.modelName}`;
    case "failed":
      return `Download failed for ${job.modelName}`;
    case "idle":
      return "";
  }
}

function formatModelDownloadTitle(job: ModelDownloadJob): string {
  switch (job.phase) {
    case "downloading":
      return `${job.repoId} is downloading in the background`;
    case "completed":
      return `Downloaded ${job.repoId} to ${job.downloadPath}`;
    case "failed":
      return `${job.repoId}: ${job.message}`;
    case "idle":
      return "";
  }
}

function NodeNameEditor({
  node,
  disabled,
  onRename,
}: {
  node: TreeNode;
  disabled: boolean;
  onRename: (name: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node.name ?? "");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setDraft(node.name ?? "");
    setEditing(false);
  }, [node.id, node.name]);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  function commit() {
    onRename(draft.trim() || null);
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setDraft(node.name ?? "");
            setEditing(false);
          }
        }}
        placeholder="Untitled section"
        className="bw-node-name-input"
      />
    );
  }

  const hasName = !!node.name?.trim();
  return (
    <button
      type="button"
      className={`bw-node-name${hasName ? "" : " is-empty"}`}
      onClick={() => {
        if (!disabled) setEditing(true);
      }}
      disabled={disabled}
      title={hasName ? "Rename this section" : "Name this section"}
    >
      <span>{hasName ? node.name : "Untitled section"}</span>
    </button>
  );
}

const AUTOCOMPLETE_POOL_TARGET = 10;
const COLLAPSED_RAIL_WIDTH = 40;
const SINGLE_ROW_BRANCH_PANE_RATIO = 0.5;
const TWO_ROW_BRANCH_PANE_RATIO = 0.65;
const MANY_ROW_BRANCH_PANE_RATIO = 0.75;

// Trim a partial trailing word off the prompt before sending it to the model.
// BPE tokenizers fold a leading space into each word ("Hello", " world"), so a
// prompt that ends mid-word ("Hello wor") forces the model to start from a
// non-canonical token boundary and tends to derail. Walk back to the last
// whitespace within a small window, hand the model a clean "after the space"
// position, and remember the dropped fragment so the chunk handler can filter
// completions to ones that pick up where the user left off.
const AUTOCOMPLETE_TRIM_WINDOW = 64;
function trimAutocompletePromptSuffix(prompt: string): {
  trimmedPrompt: string;
  partial: string;
} {
  if (prompt.length === 0) return { trimmedPrompt: prompt, partial: "" };
  const lastChar = prompt[prompt.length - 1]!;
  if (/\s/.test(lastChar)) return { trimmedPrompt: prompt, partial: "" };
  const start = Math.max(0, prompt.length - AUTOCOMPLETE_TRIM_WINDOW);
  let lastWsIdx = -1;
  for (let i = prompt.length - 1; i >= start; i--) {
    if (/\s/.test(prompt[i]!)) {
      lastWsIdx = i;
      break;
    }
  }
  if (lastWsIdx < 0) return { trimmedPrompt: prompt, partial: "" };
  return {
    trimmedPrompt: prompt.slice(0, lastWsIdx + 1),
    partial: prompt.slice(lastWsIdx + 1),
  };
}

function branchPaneRatioForCount(count: number): number {
  const columns = branchGridColumns(count);
  if (columns === null) return MANY_ROW_BRANCH_PANE_RATIO;
  const rows = Math.ceil(count / columns);
  if (rows <= 1) return SINGLE_ROW_BRANCH_PANE_RATIO;
  if (rows === 2) return TWO_ROW_BRANCH_PANE_RATIO;
  return MANY_ROW_BRANCH_PANE_RATIO;
}

export default function App() {
  const [workspace, dispatchWorkspace] = useReducer(
    workspaceReducer,
    initialWorkspaceState,
  );
  const {
    project,
    tree,
    currentId,
    buffer,
    mapSelectedId,
    mapSelectionIds,
    mapLocateRequest,
    streaming,
    saving,
    error,
  } = workspace;
  // Thin wrapper setters keep every existing call site unchanged while the
  // state lives in one reducer. `dispatchWorkspace` is stable, so wrapping each
  // in useCallback reproduces the stable identity useState setters had (some
  // are listed in effect/callback dependency arrays). Stage B replaces the
  // coupled multi-setter handlers with single semantic dispatches; these
  // wrappers stay for the standalone / high-frequency / externally-handed-out
  // updates (editor typing, the async flags, the many error sites, and
  // NodeMapView's own selection setters).
  const setBuffer = useCallback<Dispatch<SetStateAction<string>>>(
    (value) => dispatchWorkspace({ type: "setBuffer", value }),
    [],
  );
  const setMapSelectedId = useCallback<Dispatch<SetStateAction<string | null>>>(
    (value) => dispatchWorkspace({ type: "setMapSelectedId", value }),
    [],
  );
  const setMapSelectionIds = useCallback<Dispatch<SetStateAction<string[]>>>(
    (value) => dispatchWorkspace({ type: "setMapSelectionIds", value }),
    [],
  );
  const setMapLocateRequest = useCallback<Dispatch<SetStateAction<number>>>(
    (value) => dispatchWorkspace({ type: "setMapLocateRequest", value }),
    [],
  );
  const setStreaming = useCallback<Dispatch<SetStateAction<boolean>>>(
    (value) => dispatchWorkspace({ type: "setStreaming", value }),
    [],
  );
  const setSaving = useCallback<Dispatch<SetStateAction<boolean>>>(
    (value) => dispatchWorkspace({ type: "setSaving", value }),
    [],
  );
  const setError = useCallback<Dispatch<SetStateAction<string | null>>>(
    (value) => dispatchWorkspace({ type: "setError", value }),
    [],
  );
  const [loadingProject, setLoadingProject] = useState(true);
  const [modelPanelOpen, setModelPanelOpen] = useState(false);
  const [tokenCount, setTokenCount] = useState<number | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [starredOnly, setStarredOnly] = useState(false);
  const [treeSearch, setTreeSearch] = useState("");

  const candidatesApi = useCandidates({ streaming, saving });
  const {
    candidates,
    candidateContext,
    candidatePrompt,
    candidateBaseId,
    candidateModelId,
    candidateSamplerSnapshot,
    savedCandidateIds,
    pickedCandidateIndex,
    usedCandidateRange,
    visibleCandidateIndex,
    branchViewMode,
    branchPickerOpen,
    visibleCandidate,
    setCandidates,
    setVisibleCandidateIndex,
    setBranchViewMode,
    setUsedCandidateRange,
    clearBranchPicker,
    startGeneration,
    markUsed,
    markKept,
    cycleVisibleCandidate,
    dropCandidate,
  } = candidatesApi;

  const models = useModelLoader({
    setError,
    formatError,
    onModelUnloaded: () => setTokenCount(null),
  });
  // App itself only needs these few; the model panel consumes the rest.
  const {
    currentTabbyModel,
    loadingModels,
    refreshModels,
    downloadJob,
    clearDownloadJob,
  } = models;
  const [presets, setPresets] = useState<SamplerPreset[]>([]);
  const [activePresetId, setActivePresetIdState] = useState<string | null>(null);
  const [draftBody, setDraftBody] = useState<SamplerBody>(() => neutralBody());
  const [samplerBusy, setSamplerBusy] = useState(false);
  const [samplerOpen, setSamplerOpen] = useState(false);
  const [banListOpen, setBanListOpen] = useState(false);
  const banListAnchorRef = useRef<HTMLDivElement>(null);
  const [treeMenu, setTreeMenu] = useState<TreeContextMenu | null>(null);
  const [collapsedNodes, setCollapsedNodes] = useState<Record<string, boolean>>({});
  const [expandedChains, setExpandedChains] = useState<Record<string, boolean>>({});
  const [composeDisplayMode, setComposeDisplayMode] =
    useState<ComposeDisplayMode>("cards");
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("compose");
  const [autocompleteState, setAutocompleteState] = useState<AutocompleteState>({
    phase: "idle",
  });
  const [autocompleteStatus, setAutocompleteStatus] = useState<string | null>(null);
  const [branchPaneRatio, setBranchPaneRatio] = useState(SINGLE_ROW_BRANCH_PANE_RATIO);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [manualPathRequest, setManualPathRequest] = useState<ManualPathRequest | null>(
    null,
  );
  const [manualPathInput, setManualPathInput] = useState("");
  const [treeVisible, setTreeVisible] = useState(true);
  const [treeWidth, setTreeWidth] = useState(288);
  const [mapFitRequest, setMapFitRequest] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const autocompleteAbortRef = useRef<AbortController | null>(null);
  // Tail of the serialized project-settings write chain (see saveProjectSettings).
  const settingsWriteChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const editorRef = useRef<WorkbookEditorHandle | null>(null);
  const manuscriptScrollRef = useRef<HTMLDivElement | null>(null);
  const bufferSelectionRef = useRef<{ start: number; end: number } | null>(null);
  const bufferSelectionArmedRef = useRef(false);
  const preserveUsedRangeForBufferRef = useRef<string | null>(null);
  // commitChatDraftsAndPersist closes over state that changes every
  // render. Stash it behind a ref so the global keyboard handler can
  // call it without re-binding (and re-running its effect) every time.
  const commitChatDraftsAndPersistRef = useRef<
    (() => Promise<{ tree: Tree; currentId: string } | null>) | null
  >(null);
  // Single-slot undo for the most recent Delete action. Cleared when any
  // other tree mutation persists, so cmd+Z always restores the last delete
  // and nothing earlier.
  const pendingDeleteUndoRef = useRef<{
    deletedIds: string[];
    prevCurrentId: string;
    prevSelectedId: string;
  } | null>(null);

  const contextMax = modelContextMax(currentTabbyModel);
  const maxBranches = maxBranchesForModel(currentTabbyModel);
  const branchControls = useBranchControls({
    maxBranches,
    contextMax,
    saveProjectSettings,
  });
  // hydrate is stable (the only branch-control function used inside a memoized
  // callback's deps); pull it out so loadProject can depend on a bare ref.
  const { hydrate: hydrateBranchControls } = branchControls;
  const banList = useBanList(saveProjectSettings);
  const { hydrate: hydrateBanList } = banList;
  // The banned strings a generation should actually send. The project list applies when
  // the master switch is on, otherwise nothing. The project list is the only
  // source of banned strings now that the sampler drawer no longer offers them.
  const activeBannedStrings = useMemo(
    () => (banList.enabled ? banList.bannedStrings : []),
    [banList.enabled, banList.bannedStrings],
  );
  const branchLimitMessage =
    branchControls.branchCap < maxBranches
      ? `capped at ${branchControls.branchCap} while Diverse is on`
      : maxBranches >= MAX_BRANCH_UI_LIMIT
        ? `capped at ${MAX_BRANCH_UI_LIMIT} for readable layouts`
        : `max ${maxBranches} with this model`;
  const autocompleteSuggestion =
    autocompleteState.phase === "showing"
      ? (autocompleteState.suggestions[autocompleteState.visibleIdx] ?? null)
      : null;
  const contextPct = tokenCount !== null && contextMax ? tokenCount / contextMax : null;
  const contextWarn = contextPct !== null && contextPct >= 0.9;
  const modelStatusLabel = streaming
    ? "Model loaded; generation streaming"
    : currentTabbyModel
      ? "Model loaded and idle"
      : "No model loaded";
  const downloadStatusLabel = formatModelDownloadStatus(downloadJob);
  const downloadStatusTitle = formatModelDownloadTitle(downloadJob);
  const currentPath = useMemo(
    () => (tree && currentId ? pathFromRoot(tree, currentId) : []),
    [tree, currentId],
  );
  const currentPathIds = useMemo(
    () => new Set(currentPath.map((node) => node.id)),
    [currentPath],
  );
  // The conversation proper for the chat actionbar star: the active path
  // minus the root and system nodes. Those two form the shared preamble of
  // every conversation in a chat project, so a star landing there would make
  // every branch read as starred — and the unstar sweep below could clear a
  // root/system star project-wide while "unstarring one conversation".
  const chatConversationNodes = useMemo(
    () =>
      currentPath.filter((node) => node.parentId !== null && node.role !== "system"),
    [currentPath],
  );
  // The chat actionbar star is a node-level toggle on the conversation tip.
  // Earlier revisions read the whole path and swept every starred path node
  // on unstar. With long shared prefixes one sweep could clear stars that
  // other conversations relied on, so the toggle now reads and writes the
  // tip alone. A star stranded higher up the path stays visible in the
  // sidebar's starred list.
  const chatTipStarred =
    chatConversationNodes[chatConversationNodes.length - 1]?.starred ?? false;
  const tokenMeterLabel =
    tokenCount === null || contextMax === null
      ? "Current draft token count and loaded context length are unavailable"
      : `${project?.kind === "chat" ? "Approximately " : ""}${tokenCount.toLocaleString()} current draft tokens out of ${contextMax.toLocaleString()} loaded context tokens`;

  const activePreset = useMemo(
    () => presets.find((preset) => preset.id === activePresetId) ?? null,
    [presets, activePresetId],
  );
  const presetBaseline: SamplerBody = useMemo(
    () => activePreset?.body ?? {},
    [activePreset],
  );
  const draftDirty = useMemo(
    () => activePreset !== null && !bodiesEqual(draftBody, presetBaseline),
    [activePreset, draftBody, presetBaseline],
  );

  // Anchor on distance-from-bottom across a layout shift that resizes the
  // manuscript pane. The candidate panel opening (strip → grid, or closed →
  // grid via Generate) shrinks the pane, and an unfocused contenteditable's
  // caret-into-view can yank the scroll container to the top. Snapshot before
  // the state mutation, restore across two animation frames.
  function pinManuscriptScroll(): () => void {
    const scrollContainer = manuscriptScrollRef.current;
    if (!scrollContainer) return () => {};
    const distanceFromBottom =
      scrollContainer.scrollHeight -
      scrollContainer.clientHeight -
      scrollContainer.scrollTop;
    return () => {
      const restore = () => {
        const target = Math.max(
          0,
          scrollContainer.scrollHeight -
            scrollContainer.clientHeight -
            distanceFromBottom,
        );
        if (Math.abs(scrollContainer.scrollTop - target) > 0.5) {
          scrollContainer.scrollTop = target;
        }
      };
      window.requestAnimationFrame(() => {
        restore();
        window.requestAnimationFrame(restore);
      });
    };
  }

  // Pin the END OF THE ACTUAL TEXT (last .cm-line) to the bottom of the
  // manuscript viewport. Used on generate so the model's continuation
  // anchor is always visible alongside the streaming branches.
  //
  // We can't just scroll to scrollHeight: .cm-content has a min-height of
  // ~34rem (see WorkbookEditor's editorBaseTheme), so a one-line buffer
  // has a lot of empty padding below the text. Scrolling by container
  // dimensions would push the real text above the viewport. Anchor on the
  // last rendered line instead.
  //
  // Two RAFs to outlast the candidate-pane resize and any contenteditable
  // caret-into-view that fires when state updates settle.
  function scrollManuscriptToEnd(): void {
    const scrollContainer = manuscriptScrollRef.current;
    if (!scrollContainer) return;
    const apply = () => {
      const lines = scrollContainer.querySelectorAll(".cm-line");
      const lastLine = lines[lines.length - 1] as HTMLElement | undefined;
      if (!lastLine) return;
      const lineRect = lastLine.getBoundingClientRect();
      const containerRect = scrollContainer.getBoundingClientRect();
      const lineBottomInContainer =
        lineRect.bottom - containerRect.top + scrollContainer.scrollTop;
      const target = Math.max(0, lineBottomInContainer - scrollContainer.clientHeight);
      if (Math.abs(scrollContainer.scrollTop - target) > 0.5) {
        scrollContainer.scrollTop = target;
      }
    };
    window.requestAnimationFrame(() => {
      apply();
      window.requestAnimationFrame(apply);
    });
  }

  const refreshPresets = useCallback(async () => {
    try {
      const fetched = await listPresets();
      setPresets(fetched);
      return fetched;
    } catch (err) {
      setError(formatError(err));
      return [];
    }
  }, [setError]);

  const applyActivePreset = useCallback(
    (presetsList: SamplerPreset[], nextActiveId: string | null) => {
      setActivePresetIdState(nextActiveId);
      const picked =
        nextActiveId === null
          ? null
          : (presetsList.find((p) => p.id === nextActiveId) ?? null);
      setDraftBody(picked ? { ...picked.body } : neutralBody());
    },
    [],
  );

  function saveProjectSettings(patch: ProjectSettingsPatch) {
    if (!project) return;
    // Serialize settings writes through a single chain so two quick edits (e.g.
    // add then remove a banned phrase) reach the server in call order. Firing
    // them concurrently let the later request finish first and persist a stale
    // list, and the shared SQLite connection rejects overlapping writes.
    settingsWriteChainRef.current = settingsWriteChainRef.current
      .catch(() => {})
      .then(() => updateProjectSettings(patch))
      .then(() => {
        setError((current) =>
          current?.includes("/api/project/settings") ? null : current,
        );
      })
      .catch((err) => {
        setError(formatError(err));
      });
  }

  // Wait for queued project-settings writes to land before the server's current
  // project changes. The settings endpoint targets whatever project is open, so
  // a write enqueued against the old project must finish before we switch, or it
  // would apply to the next one.
  async function drainSettingsWrites() {
    try {
      await settingsWriteChainRef.current;
    } catch {
      // saveProjectSettings already surfaced any error. Here we only wait.
    }
  }

  function resetRecordedSelectionToEnd(nextBuffer: string) {
    bufferSelectionRef.current = {
      start: nextBuffer.length,
      end: nextBuffer.length,
    };
    bufferSelectionArmedRef.current = false;
  }

  const clearDeleteUndo = useCallback(() => {
    pendingDeleteUndoRef.current = null;
  }, []);
  const {
    chatTurns,
    chatTailTurn,
    chatTailNode,
    chatSystemNode,
    chatCanComposeUser,
    chatCanAddAssistantChunk,
    chatCanSubmitOrGenerate,
    chatHasPendingUserDraft,
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
    commitChatDraftsAndPersist,
    startChatAssistantGeneration,
    onSubmitChatUser,
    onDeleteChatTurn,
    onUseChatCandidate,
    onKeepChatCandidate,
    onEndChatAssistantTurn,
    onAddChatAssistantChunk,
  } = useChatController({
    tree,
    currentId,
    project,
    currentPath,
    saving,
    streaming,
    currentTabbyModel,
    draftBody,
    dispatch: dispatchWorkspace,
    candidates: candidatesApi,
    branchControls,
    activeBannedStrings,
    abortRef,
    clearDeleteUndo,
    resetRecordedSelectionToEnd,
  });
  useEffect(() => {
    commitChatDraftsAndPersistRef.current = commitChatDraftsAndPersist;
  });

  function openTreeMenu(nodeIdToOpen: string, x: number, y: number) {
    setTreeMenu({
      nodeId: nodeIdToOpen,
      x: Math.max(8, Math.min(x, window.innerWidth - 220)),
      y: Math.max(8, Math.min(y, window.innerHeight - 190)),
    });
  }

  const loadProject = useCallback(
    async (info: ProjectInfo) => {
      const [nodes, settings] = await Promise.all([listNodes(), getProjectSettings()]);
      const loaded = loadedTreeFromModels(nodes);
      const loadedBuffer = concatPathText(pathFromRoot(loaded.tree, loaded.currentId));
      dispatchWorkspace({
        type: "projectLoaded",
        project: info,
        tree: loaded.tree,
        currentId: loaded.currentId,
        buffer: loadedBuffer,
      });
      resetRecordedSelectionToEnd(loadedBuffer);
      setExpandedChains({});
      // Chat projects render their surface inside compose mode — there's no
      // separate chat workspace mode — so every project opens in "compose".
      setWorkspaceMode("compose");
      resetChatDrafts();
      setComposeDisplayMode(settings.display_mode);
      hydrateBranchControls(settings);
      hydrateBanList(settings);
      clearBranchPicker();

      // Pull the project's active preset (lives in its project_meta) and
      // seed the draft from whichever preset is selected. Failures here are
      // non-fatal — a stale active_preset_id that points at a deleted preset
      // just means "no active preset yet".
      try {
        const [allPresets, active] = await Promise.all([
          refreshPresets(),
          getActivePreset(),
        ]);
        applyActivePreset(allPresets, active.preset_id);
      } catch (err) {
        setError(formatError(err));
      }
    },
    [
      applyActivePreset,
      hydrateBranchControls,
      hydrateBanList,
      clearBranchPicker,
      refreshPresets,
      resetChatDrafts,
      setError,
    ],
  );

  useEffect(() => {
    let cancelled = false;

    async function loadCurrentProject() {
      setLoadingProject(true);
      try {
        const info = await currentProject();
        if (cancelled) return;
        if (info) {
          await loadProject(info);
        }
      } catch (err) {
        if (!cancelled) setError(formatError(err));
      } finally {
        if (!cancelled) setLoadingProject(false);
      }
    }

    void loadCurrentProject();
    return () => {
      cancelled = true;
    };
  }, [loadProject, setError]);

  useEffect(() => {
    void refreshModels();
  }, [refreshModels]);

  useEffect(() => {
    // Presets are user-global, so load them once on mount. `loadProject`
    // re-loads them when a project opens so rename/delete from another
    // window eventually reconciles.
    void refreshPresets();
  }, [refreshPresets]);

  useEffect(() => {
    if (!currentTabbyModel || !buffer) {
      setTokenCount(buffer ? null : 0);
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      encodeTokens(buffer)
        .then((payload) => {
          if (!cancelled) setTokenCount(payload.length);
        })
        .catch(() => {
          if (!cancelled) setTokenCount(null);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [buffer, currentTabbyModel]);

  useEffect(() => {
    autocompleteAbortRef.current?.abort();
    autocompleteAbortRef.current = null;

    if (workspaceMode !== "autocomplete") {
      setAutocompleteState({ phase: "idle" });
      setAutocompleteStatus(null);
      return;
    }
    setAutocompleteState({ phase: "idle" });
    if (!currentTabbyModel) {
      setAutocompleteState({ phase: "idle" });
      setAutocompleteStatus("no model loaded");
      return;
    }
    if (streaming || saving) {
      setAutocompleteState({ phase: "idle" });
      return;
    }

    const selection = bufferSelectionRef.current;
    const atEnd =
      selection === null ||
      (selection.start === buffer.length && selection.end === buffer.length);
    if (!atEnd) {
      setAutocompleteState({ phase: "idle" });
      setAutocompleteStatus(null);
      return;
    }

    const tokensPerSuggestion = resolveTokensPerSuggestion(
      branchControls.tokensPerSuggestionText,
    );
    const { trimmedPrompt, partial } = trimAutocompletePromptSuffix(buffer);
    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      const abort = new AbortController();
      autocompleteAbortRef.current = abort;
      setAutocompleteState({ phase: "thinking" });
      setAutocompleteStatus(null);

      // Project bans apply everywhere the model generates, so autocomplete
      // merges them the same way branch and chat generation do. The Banned
      // control renders only in compose mode by design. The ban list is a
      // project-level setting that stays in effect here without a separate
      // autocomplete control. Building the body inside the debounce keeps the
      // sampler merge and ban union to once per request that fires, not once
      // per keystroke.
      const requestBody = buildSamplerSnapshot(draftBody, activeBannedStrings);

      const partials = Array.from({ length: AUTOCOMPLETE_POOL_TARGET }, () => "");
      const slotsByIndex = Array.from({ length: AUTOCOMPLETE_POOL_TARGET }, () => -1);

      void streamCompletion(
        clampMinTokens(
          {
            prompt: trimmedPrompt,
            n: AUTOCOMPLETE_POOL_TARGET,
            max_tokens: tokensPerSuggestion,
            ...requestBody,
            ban_eos_token: true,
          },
          tokensPerSuggestion,
        ),
        (chunk) => {
          if (cancelled) return;
          for (const choice of chunk.choices) {
            if (
              choice.index < 0 ||
              choice.index >= AUTOCOMPLETE_POOL_TARGET ||
              !choice.text
            ) {
              continue;
            }
            partials[choice.index] += choice.text;
            const suggestion = normalizeAutocompleteSuggestion(
              partials[choice.index]!,
              partial,
            );
            if (!suggestion) continue;

            setAutocompleteState((current) => {
              if (current.phase === "idle") return current;
              const suggestions =
                current.phase === "showing" ? [...current.suggestions] : [];
              let slot = slotsByIndex[choice.index]!;
              if (slot < 0) {
                const key = suggestion.trim().toLowerCase();
                const exists = suggestions.some(
                  (item) => item.trim().toLowerCase() === key,
                );
                if (exists) return current;
                slot = suggestions.length;
                slotsByIndex[choice.index] = slot;
                suggestions.push(suggestion);
              } else {
                suggestions[slot] = suggestion;
              }
              return {
                phase: "showing",
                suggestions,
                visibleIdx:
                  current.phase === "showing"
                    ? Math.min(current.visibleIdx, suggestions.length - 1)
                    : 0,
              };
            });
          }
        },
        abort.signal,
      )
        .catch((err) => {
          if (!cancelled && (err as Error).name !== "AbortError") {
            setAutocompleteState({ phase: "idle" });
            setAutocompleteStatus("autocomplete offline");
          }
        })
        .finally(() => {
          if (autocompleteAbortRef.current === abort) {
            autocompleteAbortRef.current = null;
          }
          if (!cancelled) {
            setAutocompleteState((current) =>
              current.phase === "thinking" ? { phase: "idle" } : current,
            );
          }
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      autocompleteAbortRef.current?.abort();
      autocompleteAbortRef.current = null;
    };
  }, [
    buffer,
    currentTabbyModel,
    draftBody,
    activeBannedStrings,
    saving,
    streaming,
    branchControls.tokensPerSuggestionText,
    workspaceMode,
  ]);

  const commitBuffer = useCallback(
    async (
      nextBuffer = buffer,
      source: NodeSource = "user_written",
    ): Promise<CommitResult | null> => {
      if (!project || !tree || !currentId) {
        setError("Create or open a project before saving.");
        return null;
      }
      if (project.kind === "chat") {
        return { tree, currentId, buffer };
      }
      if (streaming || saving) return null;
      if (!beginTreeMutation()) return null;

      setSaving(true);
      setError(null);
      try {
        const reshaped = reshape(tree, currentId, nextBuffer, {
          newId: nodeId,
          now: nowEpoch,
          source,
        });
        const batch = mutationBatchFromTrees(tree, reshaped.tree, reshaped.currentId);

        await mutateNodes(batch);
        dispatchWorkspace({
          type: "bufferReshaped",
          tree: reshaped.tree,
          currentId: reshaped.currentId,
          buffer: nextBuffer,
        });
        // commitBuffer fires on any non-trivial buffer reshape; if there
        // were edits to flush, the previous delete-undo is no longer the
        // last thing the user did.
        if (reshaped.tree !== tree) pendingDeleteUndoRef.current = null;

        return {
          tree: reshaped.tree,
          currentId: reshaped.currentId,
          buffer: nextBuffer,
        };
      } catch (err) {
        setError(formatError(err));
        return null;
      } finally {
        setSaving(false);
        endTreeMutation();
      }
    },
    [buffer, currentId, project, saving, setError, setSaving, streaming, tree],
  );

  const onGenerateRef = useLatestRef(onGenerate);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (project?.kind === "chat") {
          // commitBuffer is a no-op for chat; route Cmd/Ctrl+S through
          // the chat-aware path so the keyboard shortcut matches the
          // Save button.
          void commitChatDraftsAndPersistRef.current?.();
        } else {
          void commitBuffer();
        }
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key === "Enter" &&
        workspaceMode === "compose" &&
        project?.kind !== "chat"
      ) {
        event.preventDefault();
        void onGenerateRef.current();
      }
      if (event.key === "Escape") {
        if (closeConfirmOpen) {
          setCloseConfirmOpen(false);
        } else if (modelPanelOpen) {
          setModelPanelOpen(false);
        } else if (samplerOpen) {
          setSamplerOpen(false);
        } else if (banListOpen) {
          setBanListOpen(false);
        } else if (treeMenu) {
          setTreeMenu(null);
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    banListOpen,
    closeConfirmOpen,
    commitBuffer,
    modelPanelOpen,
    onGenerateRef,
    project?.kind,
    samplerOpen,
    treeMenu,
    workspaceMode,
  ]);

  useEffect(() => {
    if (!banListOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (!banListAnchorRef.current?.contains(event.target as Node)) {
        setBanListOpen(false);
      }
    }
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [banListOpen]);

  useEffect(() => {
    if (!treeMenu) return;
    function onPointerDown() {
      setTreeMenu(null);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [treeMenu]);

  useEffect(() => {
    if (!tree || !currentId) return;
    const validSelection = mapSelectionIds.filter((id) => tree.nodes[id]);
    const validSelectedId =
      mapSelectedId && tree.nodes[mapSelectedId] ? mapSelectedId : null;
    if (
      validSelectedId &&
      validSelection.length === mapSelectionIds.length &&
      validSelection.includes(validSelectedId)
    ) {
      return;
    }

    const fallbackId = validSelectedId ?? currentId;
    setMapSelectedId(fallbackId);
    setMapSelectionIds([fallbackId]);
  }, [
    currentId,
    mapSelectedId,
    mapSelectionIds,
    setMapSelectedId,
    setMapSelectionIds,
    tree,
  ]);

  useEffect(() => {
    setVisibleCandidateIndex((current) =>
      candidates.length === 0 ? 0 : Math.min(current, candidates.length - 1),
    );
  }, [candidates.length, setVisibleCandidateIndex]);

  function startColumnDrag(
    event: ReactMouseEvent<HTMLDivElement>,
    setter: (n: number) => void,
    current: number,
    direction: 1 | -1,
    min: number,
    max: number,
  ) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = current;
    function onMove(ev: MouseEvent) {
      const delta = (ev.clientX - startX) * direction;
      const next = Math.max(min, Math.min(max, startWidth + delta));
      setter(next);
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function startRowDrag(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault();
    const container = event.currentTarget.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();

    function onMove(ev: MouseEvent) {
      const nextRatio = (ev.clientY - rect.top) / rect.height;
      setBranchPaneRatio(Math.max(0.14, Math.min(0.75, nextRatio)));
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

  function toggleCollapsed(id: string) {
    setCollapsedNodes((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = true;
      return next;
    });
  }

  function toggleChainExpanded(key: string) {
    setExpandedChains((prev) => {
      const next = { ...prev };
      if (next[key]) delete next[key];
      else next[key] = true;
      return next;
    });
  }

  // Default the project title to the chosen filename's stem. The user
  // can rename later; we never derive title from anything we recorded.
  function titleFromPath(path: string): string {
    const base = path.split("/").pop() ?? path;
    return base.replace(/\.bwbk$/i, "") || "Branching Workbook";
  }

  // Mirror the server dialog_create behavior: if the user didn't include
  // .bwbk, append it rather than replacing whatever they typed.
  function ensureBwbkSuffix(path: string): string {
    return path.toLowerCase().endsWith(".bwbk") ? path : `${path}.bwbk`;
  }

  async function createProjectFromPath(path: string, kind: "prose" | "chat") {
    const normalized = ensureBwbkSuffix(path);
    setLoadingProject(true);
    try {
      await drainSettingsWrites();
      const info = await createProject(normalized, titleFromPath(normalized), kind);
      await loadProject(info);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoadingProject(false);
    }
  }

  async function openProjectFromPath(path: string) {
    setLoadingProject(true);
    try {
      await drainSettingsWrites();
      const info = await openProject(path);
      await loadProject(info);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoadingProject(false);
    }
  }

  async function onCreateProject(kind: "prose" | "chat" = "prose") {
    setError(null);
    let result: DialogResult;
    try {
      result = await dialogPickNewProject();
    } catch (err) {
      setError(formatError(err));
      return;
    }
    if (result.status === "unavailable") {
      setManualPathInput("");
      setManualPathRequest({ mode: "create", kind });
      return;
    }
    if (!result.path) return;
    await createProjectFromPath(result.path, kind);
  }

  async function onOpenProject() {
    setError(null);
    let result: DialogResult;
    try {
      result = await dialogPickProject();
    } catch (err) {
      setError(formatError(err));
      return;
    }
    if (result.status === "unavailable") {
      setManualPathInput("");
      setManualPathRequest({ mode: "open" });
      return;
    }
    if (!result.path) return;
    await openProjectFromPath(result.path);
  }

  async function onSubmitManualPath() {
    if (!manualPathRequest) return;
    const path = manualPathInput.trim();
    if (!path) return;
    const request = manualPathRequest;
    setManualPathRequest(null);
    if (request.mode === "create") {
      await createProjectFromPath(path, request.kind);
    } else {
      await openProjectFromPath(path);
    }
  }

  async function onCloseProject() {
    abortRef.current?.abort();
    setLoadingProject(true);
    setError(null);
    setCloseConfirmOpen(false);
    try {
      await drainSettingsWrites();
      await closeProjectApi();
      dispatchWorkspace({ type: "projectClosed" });
      resetRecordedSelectionToEnd("");
      setExpandedChains({});
      resetChatDrafts();
      clearBranchPicker();
      // Active preset is per-project; forget it when the project closes so a
      // subsequent project open doesn't briefly show the wrong "active" name.
      applyActivePreset(presets, null);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoadingProject(false);
    }
  }

  function hasDirtyBuffer(): boolean {
    if (!project || !tree || !currentId) return false;
    if (project.kind === "chat") {
      // For close-warn purposes the compose box counts too — losing
      // half-typed compose text on close is just as bad as losing a
      // turn edit. (The actionbar Save button uses the narrower
      // chatHasUnsavedDrafts since Save can't ship a compose draft —
      // that's what Send is for.)
      return chatHasUnsavedDrafts || chatUserDraft.trim().length > 0;
    }
    return buffer !== concatPathText(pathFromRoot(tree, currentId));
  }

  function onRequestCloseProject() {
    if (hasDirtyBuffer()) {
      setCloseConfirmOpen(true);
      return;
    }
    void onCloseProject();
  }

  async function onSelectPreset(nextId: string | null) {
    applyActivePreset(presets, nextId);
    if (!project) return;
    setSamplerBusy(true);
    setError(null);
    try {
      await setActivePreset(nextId);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSamplerBusy(false);
    }
  }

  async function onSaveChanges() {
    if (!activePreset) return;
    setSamplerBusy(true);
    setError(null);
    try {
      const saved = await updatePreset(activePreset.id, { body: draftBody });
      const next = presets.map((p) => (p.id === saved.id ? saved : p));
      setPresets(next);
      setDraftBody({ ...saved.body });
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSamplerBusy(false);
    }
  }

  async function onSaveAs(name: string) {
    setSamplerBusy(true);
    setError(null);
    try {
      const created = await createPreset(name, draftBody);
      const next = [...presets, created].sort((a, b) => {
        if (a.is_starter !== b.is_starter) return a.is_starter ? -1 : 1;
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      });
      setPresets(next);
      if (project) {
        await setActivePreset(created.id);
        applyActivePreset(next, created.id);
      } else {
        applyActivePreset(next, created.id);
      }
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSamplerBusy(false);
    }
  }

  async function onDeletePreset(presetId: string) {
    setSamplerBusy(true);
    setError(null);
    try {
      await deletePreset(presetId);
      const next = presets.filter((p) => p.id !== presetId);
      setPresets(next);
      if (activePresetId === presetId) {
        applyActivePreset(next, null);
        if (project) {
          await setActivePreset(null);
        }
      }
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSamplerBusy(false);
    }
  }

  function onNeutralizeDraft() {
    setDraftBody(neutralBody());
  }

  async function onSave() {
    if (project?.kind === "chat") {
      await commitChatDraftsAndPersist();
      return;
    }
    await commitBuffer();
  }

  async function onSelectNode(nodeIdToSelect: string) {
    if (!tree || !currentId || streaming || saving) return;

    // For chat, flush any pending drafts before re-anchoring the path
    // so they don't get stranded as off-path drafts the user can't
    // see (and that the save shortcut can't reach either).
    const committed =
      project?.kind === "chat"
        ? await commitChatDraftsAndPersist()
        : await commitBuffer();
    if (!committed) return;

    const selectedId =
      project?.kind === "chat" && nodeIdToSelect === committed.tree.rootId
        ? (childrenOf(committed.tree, committed.tree.rootId).find(
            (node) => node.role === "system",
          )?.id ?? nodeIdToSelect)
        : nodeIdToSelect;
    const targetId = committed.tree.nodes[selectedId]
      ? selectedId
      : committed.currentId;
    const path = pathFromRoot(committed.tree, targetId);
    const nextBuffer = concatPathText(path);

    if (!beginTreeMutation()) return;
    setSaving(true);
    setError(null);
    try {
      await mutateNodes({ main_path: path.map((node) => node.id) });
      dispatchWorkspace({
        type: "nodeSelected",
        tree: committed.tree,
        currentId: targetId,
        buffer: nextBuffer,
      });
      resetRecordedSelectionToEnd(nextBuffer);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSaving(false);
      endTreeMutation();
    }
  }

  async function onGenerate() {
    if (streaming || saving) return;
    if (!currentTabbyModel) {
      setError("Load a model before generating.");
      return;
    }

    const committed = await commitBuffer(buffer, "user_written");
    if (!committed) return;

    const n = branchControls.normalizeBranchCount();
    if (n === null) return;
    const resolvedMaxTokens = branchControls.normalizeMaxTokens();
    const promptSnapshot = committed.buffer;
    // Resolve the sampler snapshot *now*, with the active project bans folded
    // in, so a drawer or ban-list edit mid-stream can't change what a persisted
    // node records as having produced it, and a saved node carries the bans
    // that actually shaped its text. The snapshot and the request body are the
    // same value.
    const samplerSnapshot = buildSamplerSnapshot(draftBody, activeBannedStrings);
    setError(null);
    setStreaming(true);
    scrollManuscriptToEnd();
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    try {
      // Diverse openings. Probe a pool of first-token candidates, sample one
      // opening per branch from it, then fan out one continuation per opening
      // so siblings start differently. The shared helper returns false when
      // the probe yields no usable pool, so the plain n-sample path below runs
      // instead.
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
          fetchOpenings: (probeSignal) =>
            fetchProseOpenings({ prompt: promptSnapshot, ...samplerSnapshot }, probeSignal),
          beginSeeded: (seeds) => {
            setBranchPaneRatio(branchPaneRatioForCount(seeds.length));
            startGeneration({
              context: "prose",
              count: seeds.length,
              prompt: promptSnapshot,
              baseId: committed.currentId,
              modelId: currentTabbyModel.id,
              samplerSnapshot,
            });
            setCandidates(seededCandidates(seeds));
            setVisibleCandidateIndex(0);
          },
          streamSeed: (seed, slot, continuationMax, seedSignal) =>
            streamCompletion(
              clampMinTokens(
                {
                  prompt: promptSnapshot + seed,
                  n: 1,
                  max_tokens: continuationMax,
                  ...samplerSnapshot,
                },
                continuationMax,
              ),
              (chunk) => {
                for (const choice of chunk.choices) {
                  if (!choice.text && choice.finish_reason === null) continue;
                  setCandidates((current) =>
                    appendToCandidate(current, slot, choice.text, choice.finish_reason),
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
        setBranchPaneRatio(branchPaneRatioForCount(n));
        startGeneration({
          context: "prose",
          count: n,
          prompt: promptSnapshot,
          baseId: committed.currentId,
          modelId: currentTabbyModel.id,
          samplerSnapshot,
        });
        let firstVisibleChosen = false;
        await streamCompletion(
          clampMinTokens(
            {
              prompt: promptSnapshot,
              n,
              max_tokens: resolvedMaxTokens,
              ...samplerSnapshot,
            },
            resolvedMaxTokens,
          ),
          (chunk) => {
            for (const choice of chunk.choices) {
              if (choice.index < 0 || choice.index >= n || !choice.text) continue;
              if (!firstVisibleChosen) {
                firstVisibleChosen = true;
                setVisibleCandidateIndex(choice.index);
              }
              setCandidates((current) => applyChoice(current, choice, n));
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

  function onCancel() {
    abortRef.current?.abort();
  }

  function clearAutocomplete(status: string | null = null) {
    autocompleteAbortRef.current?.abort();
    autocompleteAbortRef.current = null;
    setAutocompleteState({ phase: "idle" });
    setAutocompleteStatus(status);
  }

  function cycleAutocomplete(delta: 1 | -1): boolean {
    let handled = false;
    setAutocompleteState((current) => {
      if (current.phase !== "showing" || current.suggestions.length === 0) {
        return current;
      }
      handled = true;
      const nextIdx =
        (current.visibleIdx + delta + current.suggestions.length) %
        current.suggestions.length;
      return { ...current, visibleIdx: nextIdx };
    });
    return handled;
  }

  function normalizeAutocompleteSuggestion(
    text: string,
    partial: string,
  ): string | null {
    // Strip leading newlines so completions that begin with a paragraph
    // break still surface as a single-line ghost. Without this, any
    // suggestion whose first emitted chunk is "\n" would render blank
    // forever and never reach the user.
    const stripped = text.replace(/^[\r\n]+/, "");
    const singleLine = stripped.split(/\r?\n/, 1)[0] ?? "";
    // No trailing partial: legacy behavior — first non-blank line wins.
    if (partial.length === 0) {
      if (!singleLine.trim()) return null;
      return singleLine;
    }
    // We trimmed `partial` off the prompt before sending. To stay coherent
    // with the user's typed prefix, only surface completions whose first
    // line picks up where the user is mid-word; show them only the part
    // *after* the partial, since the prefix is already in the buffer.
    // The candidate's first line is shorter than the prefix we already trimmed
    // off the prompt — it's either still streaming (too few chars to judge yet)
    // or it has diverged from the user's prefix. Neither is showable.
    if (singleLine.length < partial.length) return null;
    if (!singleLine.startsWith(partial)) return null;
    const after = singleLine.slice(partial.length);
    if (!after) return null;
    return after;
  }

  function acceptAutocompleteSuggestion(): boolean {
    if (workspaceMode !== "autocomplete" || !autocompleteSuggestion) {
      return false;
    }
    const nextBuffer = `${buffer}${autocompleteSuggestion}`;
    setBuffer(nextBuffer);
    setUsedCandidateRange(null);
    clearAutocomplete();
    bufferSelectionRef.current = {
      start: nextBuffer.length,
      end: nextBuffer.length,
    };
    window.requestAnimationFrame(() => {
      editorRef.current?.focus();
      editorRef.current?.setSelectionRange(nextBuffer.length, nextBuffer.length);
    });
    return true;
  }

  function recordBufferSelection() {
    const selection = editorRef.current?.getSelection();
    if (!selection) return;
    bufferSelectionArmedRef.current = true;
    bufferSelectionRef.current = selection;
  }

  function recordBufferFocus() {
    bufferSelectionArmedRef.current = true;
    const selection = editorRef.current?.getSelection();
    if (selection) {
      bufferSelectionRef.current = selection;
    }
  }

  function onUseCandidate(index: number) {
    if (candidateContext === "chat") {
      void onUseChatCandidate(index);
      return;
    }
    // The inline Use button is disabled mid-stream, but the Tab keybinding
    // reaches here directly. Guard the action itself so a still-streaming
    // branch (with Diverse on, only its seed token so far) can't splice
    // partial text into the manuscript.
    if (streaming) return;

    const text = usableCandidateText(candidates[index], "using", setError);
    if (text === null) return;

    // Completions are continuations of the draft, so they always append at
    // the end of the buffer — never at a recorded cursor position, which is
    // often stale (the user clicked into the editor earlier just to read).
    // The one exception is replacing a previously-used branch with a
    // different one: that swaps in place rather than appending again.
    const canReplaceUsed = usedCandidateRange !== null;
    const start = canReplaceUsed
      ? Math.max(0, Math.min(buffer.length, usedCandidateRange.start))
      : buffer.length;
    const end = canReplaceUsed
      ? Math.max(start, Math.min(buffer.length, usedCandidateRange.end))
      : buffer.length;
    const nextBuffer = `${buffer.slice(0, start)}${text}${buffer.slice(end)}`;
    const nextCursor = start + text.length;

    // The buffer lives inside .bw-manuscript-scroll (overflow:auto), not the
    // window. When setBuffer triggers CodeMirror's wholesale doc replace the
    // editor's caret is dispatched at the prior selection head — typically
    // offset 0 if the user clicked "Use" without first focusing the editor —
    // and the contenteditable's caret-into-view behavior yanks the scroll
    // container to the top. Snapshot scrollTop here and restore it after the
    // dispatch settles.
    const scrollContainer = manuscriptScrollRef.current;
    const scrollTopBefore = scrollContainer?.scrollTop ?? null;

    preserveUsedRangeForBufferRef.current = nextBuffer;
    setBuffer(nextBuffer);
    bufferSelectionArmedRef.current = true;
    bufferSelectionRef.current = { start: nextCursor, end: nextCursor };
    markUsed(index, { start, end: nextCursor });
    window.requestAnimationFrame(() => {
      if (scrollContainer && scrollTopBefore !== null) {
        scrollContainer.scrollTop = scrollTopBefore;
      }
      editorRef.current?.focus();
      editorRef.current?.setSelectionRange(nextCursor, nextCursor);
      if (scrollContainer && scrollTopBefore !== null) {
        // setSelectionRange dispatches scrollIntoView on the cm-scroller,
        // which has overflow:visible and so cannot scroll itself — but the
        // browser may still nudge .bw-manuscript-scroll. Pin it again on the
        // following frame so the user's reading position survives.
        window.requestAnimationFrame(() => {
          if (scrollContainer.scrollTop !== scrollTopBefore) {
            scrollContainer.scrollTop = scrollTopBefore;
          }
        });
      }
    });
  }

  async function onKeepCandidate(index: number) {
    if (candidateContext === "chat") {
      await onKeepChatCandidate(index);
      return;
    }

    if (
      !tree ||
      !currentId ||
      candidatePrompt === null ||
      candidateBaseId === null ||
      saving
    ) {
      return;
    }
    if (savedCandidateIds[index]) return;

    const text = usableCandidateText(candidates[index], "keeping", setError);
    if (text === null) return;
    if (!tree.nodes[candidateBaseId]) {
      setError("The generation base no longer exists.");
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
    );
    const nextTree: Tree = {
      rootId: tree.rootId,
      nodes: {
        ...tree.nodes,
        [node.id]: node,
      },
    };

    await persistTreeMutation(tree, currentId, nextTree, {
      onSuccess: () => markKept(index, node.id),
    });
  }

  const currentNode = tree && currentId ? (tree.nodes[currentId] ?? null) : null;
  const dirtyBuffer =
    project !== null &&
    tree !== null &&
    currentId !== null &&
    (project.kind === "chat"
      ? chatHasUnsavedDrafts
      : buffer !== concatPathText(currentPath));
  const emptyDraftStartsFromRoot =
    project !== null && currentPath.length > 1 && buffer.trim().length === 0;

  const isChatProject = project?.kind === "chat";
  const showInlineCandidateControls =
    !isChatProject &&
    workspaceMode === "compose" &&
    candidateContext === "prose" &&
    composeDisplayMode === "inline" &&
    branchPickerOpen &&
    branchViewMode === "grid" &&
    visibleCandidate !== null;
  const acceptAutocompleteSuggestionRef = useLatestRef(acceptAutocompleteSuggestion);
  const onUseCandidateRef = useLatestRef(onUseCandidate);
  const cycleVisibleCandidateRef = useLatestRef(cycleVisibleCandidate);
  const editorKeyBindings = useMemo<KeyBinding[]>(
    () => [
      {
        key: "Tab",
        run: () => {
          if (acceptAutocompleteSuggestionRef.current()) return true;
          if (
            workspaceMode === "compose" &&
            composeDisplayMode === "inline" &&
            branchPickerOpen &&
            branchViewMode === "grid"
          ) {
            onUseCandidateRef.current(visibleCandidateIndex);
            return true;
          }
          return false;
        },
      },
      {
        key: "Escape",
        run: () => {
          if (workspaceMode === "autocomplete" && autocompleteState.phase !== "idle") {
            clearAutocomplete();
            return true;
          }
          if (
            workspaceMode === "compose" &&
            composeDisplayMode === "inline" &&
            branchPickerOpen &&
            branchViewMode === "grid"
          ) {
            clearBranchPicker();
            return true;
          }
          return false;
        },
      },
      {
        key: "Ctrl-]",
        run: () =>
          workspaceMode === "autocomplete"
            ? cycleAutocomplete(1)
            : composeDisplayMode === "inline"
              ? cycleVisibleCandidateRef.current(1)
              : false,
      },
      {
        key: "Ctrl-[",
        run: () =>
          workspaceMode === "autocomplete"
            ? cycleAutocomplete(-1)
            : composeDisplayMode === "inline"
              ? cycleVisibleCandidateRef.current(-1)
              : false,
      },
    ],
    [
      acceptAutocompleteSuggestionRef,
      autocompleteState.phase,
      branchPickerOpen,
      branchViewMode,
      clearBranchPicker,
      composeDisplayMode,
      cycleVisibleCandidateRef,
      onUseCandidateRef,
      visibleCandidateIndex,
      workspaceMode,
    ],
  );
  const branchColumns = branchGridColumns(candidates.length);
  const branchRemainder =
    branchColumns === null ? 0 : candidates.length % branchColumns;
  const firstCenteredBranchIndex =
    branchRemainder > 0 && branchColumns !== null
      ? candidates.length - branchRemainder
      : null;
  const centeredBranchStart =
    branchRemainder > 0 && branchColumns !== null
      ? branchColumns - branchRemainder + 1
      : null;
  const projectTitle =
    project?.title && project.title.trim() !== "Branching Workbook"
      ? project.title
      : null;
  const workspaceColumns =
    !isChatProject && workspaceMode !== "compose"
      ? "minmax(18rem, 1fr)"
      : [
          treeVisible ? `${treeWidth}px` : `${COLLAPSED_RAIL_WIDTH}px`,
          treeVisible ? "6px" : null,
          "minmax(18rem, 1fr)",
        ]
          .filter(Boolean)
          .join(" ");

  async function onRenameCurrentNode(name: string | null) {
    if (!tree || !currentId || saving || streaming) return;
    const current = tree.nodes[currentId];
    if (!current || (current.name ?? null) === name) return;

    const nextTree: Tree = {
      rootId: tree.rootId,
      nodes: {
        ...tree.nodes,
        [currentId]: { ...current, name },
      },
    };

    await persistTreeMutation(tree, currentId, nextTree);
  }

  async function onSetNodeHidden(nodeIdToUpdate: string, hidden: boolean) {
    if (!tree || !currentId || saving || streaming) return;
    const node = tree.nodes[nodeIdToUpdate];
    if (!node || node.parentId === null || node.hidden === hidden) return;
    if (hidden && nodeIdToUpdate === currentId) {
      setError("Select another node before hiding the active node.");
      return;
    }

    const nextTree: Tree = {
      rootId: tree.rootId,
      nodes: {
        ...tree.nodes,
        [nodeIdToUpdate]: { ...node, hidden },
      },
    };

    await persistTreeMutation(tree, currentId, nextTree, {
      onSuccess: () => {
        pendingDeleteUndoRef.current = null;
      },
      onSettled: () => setTreeMenu(null),
    });
  }

  async function onSetNodeStarred(nodeIdToUpdate: string, starred: boolean) {
    if (!tree || !currentId || saving || streaming) return;
    const node = tree.nodes[nodeIdToUpdate];
    if (!node || node.starred === starred) return;

    const nextTree: Tree = {
      rootId: tree.rootId,
      nodes: {
        ...tree.nodes,
        [nodeIdToUpdate]: { ...node, starred },
      },
    };

    await persistTreeMutation(tree, currentId, nextTree, {
      onSuccess: () => {
        pendingDeleteUndoRef.current = null;
      },
      onSettled: () => setTreeMenu(null),
    });
  }

  // Star or unstar the conversation tip. Both directions write exactly one
  // node, the deepest conversation node on the current path, so this toggle
  // can never touch stars on a shared prefix that other conversations rely
  // on. Starring the tip still keeps the whole conversation visible under
  // the starred filter through its lineage expansion. Both directions skip
  // the root and system nodes (see chatConversationNodes) because in an
  // empty chat the path tail is the preamble shared by every conversation
  // in the project.
  async function onSetChatConversationStarred(starred: boolean) {
    if (!tree || !currentId || saving || streaming) return;
    const tip = chatConversationNodes[chatConversationNodes.length - 1];
    if (!tip || tip.starred === starred) return;

    await persistTreeMutation(
      tree,
      currentId,
      {
        rootId: tree.rootId,
        nodes: { ...tree.nodes, [tip.id]: { ...tip, starred } },
      },
      {
        onSuccess: () => {
          pendingDeleteUndoRef.current = null;
        },
      },
    );
  }

  // Persist a single-node metadata edit — rename, star, hide, keep-a-branch —
  // that changes a field on some node but deliberately leaves the active
  // selection untouched: currentId, the buffer, and the map selection all stay
  // put, so the edit doesn't yank the user elsewhere. That's the deliberate
  // contrast with persistTreeEdit below, which relocates the active node.
  // `onSuccess` runs once the tree is committed; `onSettled` runs in `finally`
  // (e.g. closing the tree context menu regardless of outcome).
  async function persistTreeMutation(
    beforeTree: Tree,
    currentNodeId: string,
    nextTree: Tree,
    options: { onSuccess?: () => void; onSettled?: () => void } = {},
  ) {
    if (!beginTreeMutation()) return;
    setSaving(true);
    setError(null);
    try {
      await mutateNodes(mutationBatchFromTrees(beforeTree, nextTree, currentNodeId));
      dispatchWorkspace({ type: "treeMutated", tree: nextTree });
      options.onSuccess?.();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSaving(false);
      endTreeMutation();
      options.onSettled?.();
    }
  }

  // Persist a structural edit that RELOCATES the active node — delete, merge,
  // undo. Moves currentId/buffer/map-selection to nextCurrentId/nextSelectedId
  // and re-runs the map locate, where persistTreeMutation above leaves all of
  // that untouched.
  async function persistTreeEdit(
    beforeTree: Tree,
    nextTree: Tree,
    nextCurrentId: string,
    nextSelectedId = nextCurrentId,
    options: { keepDeleteUndo?: boolean } = {},
  ) {
    const nextPath = pathFromRoot(nextTree, nextCurrentId);
    const nextBuffer = concatPathText(nextPath);

    if (!beginTreeMutation()) return;
    setSaving(true);
    setError(null);
    try {
      await mutateNodes(mutationBatchFromTrees(beforeTree, nextTree, nextCurrentId));
      dispatchWorkspace({
        type: "editPersisted",
        tree: nextTree,
        currentId: nextCurrentId,
        buffer: nextBuffer,
        selectedId: nextSelectedId,
      });
      resetRecordedSelectionToEnd(nextBuffer);
      if (!options.keepDeleteUndo) pendingDeleteUndoRef.current = null;
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSaving(false);
      endTreeMutation();
    }
  }

  // Single commit boundary for any tree-mutating handler that needs
  // to "flush whatever the user was editing, then perform a tree
  // mutation against the committed state." Prose flushes the
  // workbook buffer; chat flushes per-turn + system drafts via the
  // chat-aware path. Without this, node-map operations on chat
  // projects would call commitBuffer() — which is a no-op for chat
  // — and silently mutate the tree on top of an unsaved draft set,
  // losing the drafts when they later got wiped on next save.
  async function commitAnyDrafts(): Promise<{
    tree: Tree;
    currentId: string;
  } | null> {
    if (project?.kind === "chat") {
      return commitChatDraftsAndPersist();
    }
    const committed = await commitBuffer();
    if (!committed) return null;
    return { tree: committed.tree, currentId: committed.currentId };
  }

  async function onDeleteMapNode(nodeIdToDeleteFromMap: string) {
    if (!tree || !currentId || saving || streaming) return;

    const committed = await commitAnyDrafts();
    if (!committed) return;

    const node = committed.tree.nodes[nodeIdToDeleteFromMap];
    if (!node || node.parentId === null) return;

    const idsToDelete = collectSubtreeNodeIds(committed.tree, node.id);
    const idsAlreadyDeleted = new Set(
      idsToDelete.filter((id) => committed.tree.nodes[id]?.deleted),
    );
    const newlyDeletedIds = idsToDelete.filter((id) => !idsAlreadyDeleted.has(id));
    if (newlyDeletedIds.length === 0) return;

    const nextNodes = { ...committed.tree.nodes };
    for (const id of newlyDeletedIds) {
      const target = nextNodes[id];
      if (target) nextNodes[id] = { ...target, deleted: true };
    }

    const subtreeSet = new Set(idsToDelete);
    const fallbackId = !subtreeSet.has(node.parentId)
      ? node.parentId
      : committed.tree.rootId;
    const nextCurrentId = subtreeSet.has(committed.currentId)
      ? fallbackId
      : committed.currentId;
    const nextTree: Tree = {
      rootId: committed.tree.rootId,
      nodes: nextNodes,
    };

    pendingDeleteUndoRef.current = {
      deletedIds: newlyDeletedIds,
      prevCurrentId: committed.currentId,
      prevSelectedId: nodeIdToDeleteFromMap,
    };
    await persistTreeEdit(committed.tree, nextTree, nextCurrentId, fallbackId, {
      keepDeleteUndo: true,
    });
  }

  async function onMergeNodeIntoParent(nodeIdToMerge: string) {
    if (!tree || !currentId || saving || streaming) return;

    const committed = await commitAnyDrafts();
    if (!committed) return;

    const node = committed.tree.nodes[nodeIdToMerge];
    const parent = node?.parentId ? committed.tree.nodes[node.parentId] : null;
    if (!node || !parent) return;

    const nextTree = buildMergedTree(committed.tree, parent.id, node.id);
    if (!nextTree) return;

    const nextCurrentId =
      committed.currentId === node.id ? parent.id : committed.currentId;
    await persistTreeEdit(committed.tree, nextTree, nextCurrentId, parent.id);
  }

  async function onMergeNodeWithOnlyChild(nodeIdToMerge: string) {
    if (!tree || !currentId || saving || streaming) return;

    const committed = await commitAnyDrafts();
    if (!committed) return;

    const node = committed.tree.nodes[nodeIdToMerge];
    if (!node) return;

    const child = childrenOf(committed.tree, node.id)[0] ?? null;
    if (!child) return;

    const nextTree = buildMergedTree(committed.tree, node.id, child.id);
    if (!nextTree) return;

    const nextCurrentId =
      committed.currentId === child.id ? node.id : committed.currentId;
    await persistTreeEdit(committed.tree, nextTree, nextCurrentId, node.id);
  }

  async function onMergeLinearChainDown(startId: string) {
    if (!tree || !currentId || saving || streaming) return;
    const chain = collectLinearChainDownward(tree, startId);
    if (chain.length < 2) return;
    await onMergeMapSelection(chain);
  }

  async function onMergeMapSelection(selectedIdsToMerge: string[]) {
    if (!tree || !currentId || saving || streaming) return;

    const committed = await commitAnyDrafts();
    if (!committed) return;

    const analysis = analyzeNodeMapMergeSelection(committed.tree, selectedIdsToMerge);
    if (!analysis.ok) {
      setError(analysis.reason);
      return;
    }

    const nextTree = buildMergedSelectionTree(committed.tree, analysis.orderedIds);
    if (!nextTree) {
      setError("Selection cannot be merged.");
      return;
    }

    const upstreamId = analysis.orderedIds[0]!;
    const deletedIds = new Set(analysis.orderedIds.slice(1));
    const nextCurrentId = deletedIds.has(committed.currentId)
      ? upstreamId
      : committed.currentId;
    await persistTreeEdit(committed.tree, nextTree, nextCurrentId, upstreamId);
  }

  async function onDeleteMapSelection(selectedIdsToDelete: string[]) {
    if (!tree || !currentId || saving || streaming) return;

    const committed = await commitAnyDrafts();
    if (!committed) return;

    const eligible = selectedIdsToDelete.filter(
      (id) => committed.tree.nodes[id] && committed.tree.nodes[id].parentId !== null,
    );
    if (eligible.length === 0) return;

    const subtreeSet = new Set<string>();
    for (const id of eligible) {
      for (const subId of collectSubtreeNodeIds(committed.tree, id)) {
        subtreeSet.add(subId);
      }
    }
    const newlyDeletedIds: string[] = [];
    for (const id of subtreeSet) {
      if (!committed.tree.nodes[id]?.deleted) newlyDeletedIds.push(id);
    }
    if (newlyDeletedIds.length === 0) return;

    const nextNodes = { ...committed.tree.nodes };
    for (const id of newlyDeletedIds) {
      const target = nextNodes[id];
      if (target) nextNodes[id] = { ...target, deleted: true };
    }

    let fallbackId = committed.tree.rootId;
    const firstEligibleParent = committed.tree.nodes[eligible[0]!]?.parentId;
    if (firstEligibleParent && !subtreeSet.has(firstEligibleParent)) {
      fallbackId = firstEligibleParent;
    }
    const nextCurrentId = subtreeSet.has(committed.currentId)
      ? fallbackId
      : committed.currentId;
    const nextTree: Tree = { rootId: committed.tree.rootId, nodes: nextNodes };

    pendingDeleteUndoRef.current = {
      deletedIds: newlyDeletedIds,
      prevCurrentId: committed.currentId,
      prevSelectedId: eligible[0]!,
    };
    await persistTreeEdit(committed.tree, nextTree, nextCurrentId, fallbackId, {
      keepDeleteUndo: true,
    });
  }

  async function onUndoLastDelete() {
    if (!tree || saving || streaming) return;
    const undo = pendingDeleteUndoRef.current;
    if (!undo) return;
    pendingDeleteUndoRef.current = null;

    const restorable = undo.deletedIds.filter((id) => tree.nodes[id]?.deleted === true);
    if (restorable.length === 0) return;

    const nextNodes = { ...tree.nodes };
    for (const id of restorable) {
      const target = nextNodes[id];
      if (target) nextNodes[id] = { ...target, deleted: false };
    }
    const nextTree: Tree = { rootId: tree.rootId, nodes: nextNodes };
    const nextCurrentId = nextNodes[undo.prevCurrentId]
      ? undo.prevCurrentId
      : (currentId ?? tree.rootId);
    const nextSelectedId = nextNodes[undo.prevSelectedId]
      ? undo.prevSelectedId
      : nextCurrentId;
    await persistTreeEdit(tree, nextTree, nextCurrentId, nextSelectedId);
  }

  async function onHideMapSelection(selectedIdsToHide: string[]) {
    if (!tree || !currentId || saving || streaming) return;

    const eligible = selectedIdsToHide.filter((id) => {
      const node = tree.nodes[id];
      return node && node.parentId !== null && id !== currentId && !node.hidden;
    });
    if (eligible.length === 0) return;

    const nextNodes = { ...tree.nodes };
    for (const id of eligible) {
      const node = nextNodes[id];
      if (!node) continue;
      nextNodes[id] = { ...node, hidden: true };
    }
    const nextTree: Tree = { rootId: tree.rootId, nodes: nextNodes };

    await persistTreeMutation(tree, currentId, nextTree);
  }

  async function onSetMainThread(nodeIdToPromote: string) {
    setTreeMenu(null);
    await onSelectNode(nodeIdToPromote);
  }

  return (
    <div className="bw-app">
      <header className="bw-topbar">
        <div className="bw-brand">
          <div className="bw-title">Branching Workbook</div>
          <div className="bw-project-title">{projectTitle || "No project open"}</div>
        </div>
        <div className="bw-status">
          <span
            className="bw-dot"
            data-live={currentTabbyModel !== null}
            data-streaming={streaming}
            role="status"
            aria-label={modelStatusLabel}
            title={modelStatusLabel}
          />
          <button
            type="button"
            className="bw-link-button"
            onClick={() => setModelPanelOpen(true)}
          >
            {loadingModels ? "checking model" : formatModelLabel(currentTabbyModel)}
          </button>
          {downloadJob.phase !== "idle" && (
            <span className="bw-download-chip" data-phase={downloadJob.phase}>
              <button
                type="button"
                className="bw-download-chip-main"
                onClick={() => setModelPanelOpen(true)}
                aria-label={downloadStatusLabel}
                title={downloadStatusTitle}
              >
                <span className="bw-download-chip-dot" aria-hidden="true" />
                <span className="bw-download-chip-text">{downloadStatusLabel}</span>
              </button>
              {downloadJob.phase !== "downloading" && (
                <button
                  type="button"
                  className="bw-download-chip-dismiss"
                  onClick={clearDownloadJob}
                  aria-label="Dismiss download status"
                  title="Dismiss download status"
                >
                  x
                </button>
              )}
            </span>
          )}
          {project && (
            <>
              <span
                className="bw-token-meter"
                data-warn={contextWarn}
                aria-label={tokenMeterLabel}
                title={tokenMeterLabel}
              >
                <strong>
                  {tokenCount === null
                    ? "unknown"
                    : `${project.kind === "chat" ? "~" : ""}${tokenCount.toLocaleString()}`}
                </strong>
                {" / "}
                {contextMax === null ? "unknown" : contextMax.toLocaleString()}
                {" tokens"}
              </span>
              <span className="bw-status-sep" aria-hidden="true">
                ·
              </span>
              <button
                type="button"
                className="bw-link-button"
                onClick={onRequestCloseProject}
                disabled={saving || streaming}
              >
                close project
              </button>
            </>
          )}
        </div>
      </header>

      {error && (
        <div className="bw-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {closeConfirmOpen && (
        <div
          className="bw-modal-backdrop"
          role="dialog"
          aria-label="Discard unsaved changes"
          onMouseDown={() => setCloseConfirmOpen(false)}
        >
          <section
            className="bw-confirm"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="bw-confirm-title">Discard unsaved changes?</div>
            <p>
              The current buffer has edits that have not been saved into the workbook.
            </p>
            <div className="bw-confirm-actions">
              <button
                type="button"
                className="bw-button"
                onClick={() => setCloseConfirmOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="bw-button bw-button-danger"
                onClick={() => void onCloseProject()}
              >
                Discard & close
              </button>
            </div>
          </section>
        </div>
      )}

      {manualPathRequest && (
        <div
          className="bw-modal-backdrop"
          role="dialog"
          aria-label={
            manualPathRequest.mode === "create"
              ? "Enter path for new workbook"
              : "Enter path of workbook to open"
          }
          onMouseDown={() => setManualPathRequest(null)}
        >
          <section
            className="bw-confirm"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="bw-confirm-title">
              {manualPathRequest.mode === "create"
                ? `New ${manualPathRequest.kind} workbook`
                : "Open workbook"}
            </div>
            <p>
              Native file dialog isn't available on this platform. Enter the full path
              to {manualPathRequest.mode === "create" ? "save the new" : "the"}{" "}
              <code>.bwbk</code> file.
            </p>
            <input
              type="text"
              className="bw-input w-full"
              autoFocus
              placeholder="/path/to/workbook.bwbk"
              value={manualPathInput}
              onChange={(event) => setManualPathInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void onSubmitManualPath();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setManualPathRequest(null);
                }
              }}
            />
            <div className="bw-confirm-actions">
              <button
                type="button"
                className="bw-button"
                onClick={() => setManualPathRequest(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="bw-button bw-button-primary"
                onClick={() => void onSubmitManualPath()}
                disabled={!manualPathInput.trim()}
              >
                {manualPathRequest.mode === "create" ? "Create" : "Open"}
              </button>
            </div>
          </section>
        </div>
      )}

      {treeMenu && tree && (
        <div
          className="bw-context-menu"
          style={{ left: treeMenu.x, top: treeMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => void onSetMainThread(treeMenu.nodeId)}
            disabled={saving || streaming || treeMenu.nodeId === currentId}
          >
            Set as main thread
          </button>
          {workspaceMode === "map" && (
            <button
              type="button"
              onClick={() => {
                const nodeIdToOpen = treeMenu.nodeId;
                setTreeMenu(null);
                setWorkspaceMode("compose");
                void onSelectNode(nodeIdToOpen);
              }}
              disabled={saving || streaming}
            >
              Open in compose
            </button>
          )}
          <button
            type="button"
            onClick={() =>
              void onSetNodeStarred(
                treeMenu.nodeId,
                !tree.nodes[treeMenu.nodeId]?.starred,
              )
            }
            disabled={saving || streaming}
          >
            {tree.nodes[treeMenu.nodeId]?.starred ? "Unstar node" : "Star node"}
          </button>
          <button
            type="button"
            onClick={() =>
              void onSetNodeHidden(
                treeMenu.nodeId,
                !tree.nodes[treeMenu.nodeId]?.hidden,
              )
            }
            disabled={
              saving ||
              streaming ||
              tree.nodes[treeMenu.nodeId]?.parentId === null ||
              (treeMenu.nodeId === currentId && !tree.nodes[treeMenu.nodeId]?.hidden)
            }
            title={
              treeMenu.nodeId === currentId && !tree.nodes[treeMenu.nodeId]?.hidden
                ? "Select another node before hiding the active node."
                : undefined
            }
          >
            {tree.nodes[treeMenu.nodeId]?.hidden ? "Unhide node" : "Hide node"}
          </button>
        </div>
      )}

      <SamplerDrawer
        open={samplerOpen}
        presets={presets}
        activePresetId={activePresetId}
        draft={draftBody}
        busy={samplerBusy}
        dirty={draftDirty}
        projectOpen={project !== null}
        onClose={() => setSamplerOpen(false)}
        onSelectPreset={(id) => void onSelectPreset(id)}
        onDraftChange={setDraftBody}
        onSaveChanges={() => void onSaveChanges()}
        onSaveAs={(name) => void onSaveAs(name)}
        onDeletePreset={(id) => void onDeletePreset(id)}
        onNeutralize={onNeutralizeDraft}
      />

      {modelPanelOpen && (
        <ModelPanel
          models={models}
          streaming={streaming}
          modelLabel={formatModelLabel(currentTabbyModel)}
          onClose={() => setModelPanelOpen(false)}
        />
      )}

      {!project && (
        <main className="bw-editor">
          <div className="bw-manuscript-scroll">
            <section className="bw-manuscript bw-welcome">
              <div className="bw-welcome-head">
                <div className="bw-kicker">Project</div>
                <h1 className="bw-welcome-title">Open a workbook</h1>
                <p className="bw-welcome-lede">
                  A workbook is a single <code>.bwbk</code> file.
                </p>
              </div>
              <div className="bw-welcome-actions">
                <button
                  type="button"
                  onClick={() => void onCreateProject("prose")}
                  disabled={loadingProject}
                  className="bw-button bw-button-primary"
                >
                  New prose workbook…
                </button>
                <button
                  type="button"
                  onClick={() => void onCreateProject("chat")}
                  disabled={loadingProject}
                  className="bw-button"
                >
                  New chat workbook…
                </button>
                <button
                  type="button"
                  onClick={() => void onOpenProject()}
                  disabled={loadingProject}
                  className="bw-button"
                >
                  Open existing…
                </button>
              </div>
            </section>
          </div>
        </main>
      )}

      {project && tree && currentId && (
        <div
          className="bw-workspace"
          data-picker={branchPickerOpen}
          data-tree={treeVisible}
          data-mode={workspaceMode}
          style={{ gridTemplateColumns: workspaceColumns }}
        >
          <TreeSidebar
            tree={tree}
            currentId={currentId}
            currentPathIds={currentPathIds}
            isChatProject={isChatProject}
            workspaceMode={workspaceMode}
            treeVisible={treeVisible}
            saving={saving}
            streaming={streaming}
            showHidden={showHidden}
            starredOnly={starredOnly}
            treeSearch={treeSearch}
            collapsedNodes={collapsedNodes}
            expandedChains={expandedChains}
            setShowHidden={setShowHidden}
            setStarredOnly={setStarredOnly}
            setTreeSearch={setTreeSearch}
            setTreeVisible={setTreeVisible}
            setExpandedChains={setExpandedChains}
            toggleCollapsed={toggleCollapsed}
            toggleChainExpanded={toggleChainExpanded}
            onSelectNode={onSelectNode}
            onSetNodeStarred={onSetNodeStarred}
            openTreeMenu={openTreeMenu}
            onTreeResizeStart={(event) =>
              startColumnDrag(event, setTreeWidth, treeWidth, 1, 180, 480)
            }
          />

          <main className="bw-editor">
            {!isChatProject && (
              <nav className="bw-mode-tabs" aria-label="Writing mode">
                <button
                  type="button"
                  data-active={workspaceMode === "compose"}
                  onClick={() => {
                    if (workspaceMode !== "compose") {
                      void commitBuffer();
                    }
                    setWorkspaceMode("compose");
                    clearAutocomplete();
                  }}
                  disabled={saving}
                >
                  Compose
                </button>
                <button
                  type="button"
                  data-active={workspaceMode === "autocomplete"}
                  onClick={() => {
                    if (streaming) return;
                    setWorkspaceMode("autocomplete");
                    bufferSelectionRef.current = {
                      start: buffer.length,
                      end: buffer.length,
                    };
                    window.requestAnimationFrame(() => {
                      editorRef.current?.focus();
                      editorRef.current?.setSelectionRange(
                        buffer.length,
                        buffer.length,
                      );
                    });
                  }}
                  disabled={streaming}
                >
                  Autocomplete
                </button>
                <button
                  type="button"
                  data-active={workspaceMode === "map"}
                  onClick={() => {
                    if (streaming) return;
                    clearAutocomplete();
                    setWorkspaceMode("map");
                    if (dirtyBuffer) {
                      // The map mounts and fits against the current tree; once
                      // the dirty buffer commits and reshapes the tree, re-fit
                      // so the newly committed node stays framed.
                      void commitBuffer().finally(() =>
                        setMapFitRequest((value) => value + 1),
                      );
                    }
                  }}
                  disabled={streaming || saving}
                >
                  Node Map
                </button>
              </nav>
            )}
            <div
              className="bw-editor-main"
              data-branch-view={
                workspaceMode === "compose" && branchPickerOpen
                  ? branchViewMode
                  : "none"
              }
            >
              {!isChatProject &&
                workspaceMode === "compose" &&
                candidateContext === "prose" &&
                branchPickerOpen && (
                  <BranchPicker
                    candidates={candidates}
                    savedCandidateIds={savedCandidateIds}
                    pickedCandidateIndex={pickedCandidateIndex}
                    branchViewMode={branchViewMode}
                    composeDisplayMode={composeDisplayMode}
                    branchPaneRatio={branchPaneRatio}
                    streaming={streaming}
                    saving={saving}
                    branchColumns={branchColumns}
                    firstCenteredBranchIndex={firstCenteredBranchIndex}
                    centeredBranchStart={centeredBranchStart}
                    onUseCandidate={onUseCandidate}
                    onKeepCandidate={onKeepCandidate}
                    clearBranchPicker={clearBranchPicker}
                    dropCandidate={dropCandidate}
                    setBranchViewMode={setBranchViewMode}
                    startRowDrag={startRowDrag}
                    pinManuscriptScroll={pinManuscriptScroll}
                  />
                )}

              {isChatProject ? (
                <ChatSurface
                  chatTurns={chatTurns}
                  chatTailTurn={chatTailTurn}
                  chatTailNode={chatTailNode}
                  chatTurnDrafts={chatTurnDrafts}
                  setChatTurnDrafts={setChatTurnDrafts}
                  chatUserDraft={chatUserDraft}
                  setChatUserDraft={setChatUserDraft}
                  chatCanComposeUser={chatCanComposeUser}
                  chatSystemNode={chatSystemNode}
                  chatSystemExpanded={chatSystemExpanded}
                  setChatSystemExpanded={setChatSystemExpanded}
                  chatSystemDraft={chatSystemDraft}
                  setChatSystemDraft={setChatSystemDraft}
                  branchPickerOpen={branchPickerOpen}
                  candidateContext={candidateContext}
                  saving={saving}
                  streaming={streaming}
                  commitChatDraftsAndPersist={commitChatDraftsAndPersist}
                  onEndChatAssistantTurn={onEndChatAssistantTurn}
                  onDeleteChatTurn={onDeleteChatTurn}
                  onSubmitChatUser={onSubmitChatUser}
                  onSaveChatSystem={onSaveChatSystem}
                  candidates={candidates}
                  savedCandidateIds={savedCandidateIds}
                  pickedCandidateIndex={pickedCandidateIndex}
                  onUseCandidate={onUseCandidate}
                  onKeepCandidate={onKeepCandidate}
                  clearBranchPicker={clearBranchPicker}
                />
              ) : workspaceMode === "map" ? (
                <NodeMapView
                  tree={tree}
                  currentId={currentId}
                  currentNode={currentNode}
                  currentPathIds={currentPathIds}
                  saving={saving}
                  streaming={streaming}
                  mapSelectedId={mapSelectedId}
                  mapSelectionIds={mapSelectionIds}
                  mapLocateRequest={mapLocateRequest}
                  mapFitRequest={mapFitRequest}
                  setMapSelectedId={setMapSelectedId}
                  setMapSelectionIds={setMapSelectionIds}
                  setMapLocateRequest={setMapLocateRequest}
                  setMapFitRequest={setMapFitRequest}
                  setWorkspaceMode={setWorkspaceMode}
                  openTreeMenu={openTreeMenu}
                  onSelectNode={onSelectNode}
                  onSetNodeStarred={onSetNodeStarred}
                  onSetNodeHidden={onSetNodeHidden}
                  onDeleteMapNode={onDeleteMapNode}
                  onDeleteMapSelection={onDeleteMapSelection}
                  onHideMapSelection={onHideMapSelection}
                  onMergeMapSelection={onMergeMapSelection}
                  onMergeLinearChainDown={onMergeLinearChainDown}
                  onMergeNodeIntoParent={onMergeNodeIntoParent}
                  onMergeNodeWithOnlyChild={onMergeNodeWithOnlyChild}
                  onUndoLastDelete={onUndoLastDelete}
                  canUndoLastDelete={() => pendingDeleteUndoRef.current !== null}
                />
              ) : (
                <>
                  <div className="bw-manuscript-scroll" ref={manuscriptScrollRef}>
                    <section className="bw-manuscript">
                      {currentNode && (
                        <div className="bw-manuscript-head mb-4">
                          <NodeNameEditor
                            node={currentNode}
                            disabled={saving || streaming}
                            onRename={(name) => void onRenameCurrentNode(name)}
                          />
                          <button
                            type="button"
                            className="bw-node-star"
                            data-on={currentNode.starred}
                            aria-label={
                              currentNode.starred
                                ? "Unstar this node"
                                : "Star this node"
                            }
                            aria-pressed={currentNode.starred}
                            title={
                              currentNode.starred
                                ? "Unstar this node"
                                : "Star this node"
                            }
                            disabled={saving || streaming}
                            onClick={() =>
                              void onSetNodeStarred(
                                currentNode.id,
                                !currentNode.starred,
                              )
                            }
                          >
                            {currentNode.starred ? "★" : "☆"}
                          </button>
                        </div>
                      )}
                      <WorkbookEditor
                        key={currentId}
                        ref={editorRef}
                        value={buffer}
                        onChange={(nextBuffer) => {
                          setBuffer(nextBuffer);
                          if (preserveUsedRangeForBufferRef.current === nextBuffer) {
                            preserveUsedRangeForBufferRef.current = null;
                          } else {
                            preserveUsedRangeForBufferRef.current = null;
                            setUsedCandidateRange(null);
                          }
                        }}
                        onSelectionChange={(selection: EditorSelection) => {
                          if (bufferSelectionArmedRef.current) {
                            bufferSelectionRef.current = selection;
                          }
                        }}
                        onFocus={recordBufferFocus}
                        onBlur={recordBufferSelection}
                        placeholder="Start writing..."
                        disabled={saving}
                        ghostText={
                          workspaceMode === "autocomplete"
                            ? autocompleteSuggestion
                            : workspaceMode === "compose" &&
                                composeDisplayMode === "inline" &&
                                branchPickerOpen &&
                                branchViewMode === "grid" &&
                                visibleCandidate
                              ? visibleCandidate.text
                              : null
                        }
                        keyBindings={editorKeyBindings}
                      />
                      {emptyDraftStartsFromRoot && (
                        <div className="bw-root-start-warning">
                          Empty draft: the next save or generation starts a new path
                          from root.
                        </div>
                      )}
                      {workspaceMode === "autocomplete" && (
                        <div className="bw-autocomplete-hint">
                          {autocompleteStatus ??
                            (autocompleteState.phase === "thinking"
                              ? "autocomplete thinking"
                              : autocompleteSuggestion
                                ? "Tab accept · Esc dismiss · Ctrl+] / Ctrl+[ cycle"
                                : "autocomplete ready")}
                        </div>
                      )}
                    </section>
                  </div>
                  {showInlineCandidateControls && visibleCandidate && (
                    <InlineCandidateControls
                      visibleCandidate={visibleCandidate}
                      visibleCandidateIndex={visibleCandidateIndex}
                      candidatesLength={candidates.length}
                      streaming={streaming}
                      saving={saving}
                      savedCandidateIds={savedCandidateIds}
                      cycleVisibleCandidate={cycleVisibleCandidate}
                      onUseCandidate={onUseCandidate}
                      onKeepCandidate={onKeepCandidate}
                      clearBranchPicker={clearBranchPicker}
                    />
                  )}
                </>
              )}
            </div>

            <footer className="bw-actionbar">
              <div className="bw-actionbar-left">
                {workspaceMode !== "map" && (
                  <>
                    <label className="bw-field">
                      Preset
                      <select
                        value={activePresetId ?? ""}
                        onChange={(event) =>
                          void onSelectPreset(event.target.value || null)
                        }
                        disabled={samplerBusy || streaming}
                        className="bw-select min-w-32"
                      >
                        <option value="">(none)</option>
                        {presets.map((preset) => (
                          <option key={preset.id} value={preset.id}>
                            {preset.is_starter
                              ? `${preset.name} (starter)`
                              : preset.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {draftDirty && (
                      <span
                        title="Unsaved sampler changes"
                        className="text-[color:var(--warn)]"
                      >
                        *
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => setSamplerOpen(true)}
                      disabled={samplerBusy}
                      className="bw-button"
                    >
                      Samplers
                    </button>
                  </>
                )}
                {workspaceMode === "compose" ? (
                  <>
                    <label className="bw-field">
                      Branches
                      <input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        min={1}
                        max={branchControls.branchCap}
                        value={branchControls.branchCountText}
                        onChange={(event) =>
                          branchControls.onBranchCountChange(event.target.value)
                        }
                        onBlur={() => {
                          branchControls.normalizeBranchCount();
                        }}
                        aria-invalid={branchControls.branchCountError !== null}
                        disabled={streaming || saving}
                        className="bw-input w-16"
                        title={branchLimitMessage}
                      />
                      {(branchControls.branchCountError ||
                        branchControls.branchLimitHint) && (
                        <span
                          className="bw-field-note"
                          data-error={branchControls.branchCountError !== null}
                        >
                          {branchControls.branchCountError ?? branchLimitMessage}
                        </span>
                      )}
                    </label>
                    <label className="bw-field">
                      Max tokens
                      <input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        min={1}
                        max={contextMax ?? undefined}
                        value={branchControls.maxTokensText}
                        onChange={(event) =>
                          branchControls.onMaxTokensChange(event.target.value)
                        }
                        onBlur={() => {
                          branchControls.normalizeMaxTokens();
                        }}
                        aria-invalid={branchControls.maxTokensError !== null}
                        disabled={streaming || saving}
                        className="bw-input w-20"
                        title={
                          contextMax
                            ? `1-${contextMax.toLocaleString()} (loaded context)`
                            : undefined
                        }
                      />
                      {(branchControls.maxTokensError ||
                        branchControls.maxTokensLimitHint) && (
                        <span
                          className="bw-field-note"
                          data-error={branchControls.maxTokensError !== null}
                        >
                          {branchControls.maxTokensError ??
                            (contextMax
                              ? `capped at ${contextMax.toLocaleString()} (loaded context)`
                              : "capped at the loaded context length")}
                        </span>
                      )}
                    </label>
                    {!isChatProject && (
                      <div className="bw-display-toggle" aria-label="Display mode">
                        <span>Display</span>
                        <button
                          type="button"
                          data-active={composeDisplayMode === "cards"}
                          onClick={() => {
                            setComposeDisplayMode("cards");
                            saveProjectSettings({ display_mode: "cards" });
                          }}
                        >
                          cards
                        </button>
                        <button
                          type="button"
                          data-active={composeDisplayMode === "inline"}
                          onClick={() => {
                            setComposeDisplayMode("inline");
                            saveProjectSettings({ display_mode: "inline" });
                          }}
                        >
                          inline
                        </button>
                      </div>
                    )}
                    <Switch
                      label="Diverse"
                      checked={branchControls.seededBranches}
                      onChange={() => branchControls.onToggleSeededBranches()}
                      disabled={streaming || saving}
                    >
                      <InfoDot info={DIVERSE_OPENINGS_INFO} />
                    </Switch>
                    <div className="bw-banlist-anchor" ref={banListAnchorRef}>
                      <button
                        type="button"
                        className="bw-button"
                        data-active={banListOpen}
                        data-bans-off={
                          banList.bannedStrings.length > 0 && !banList.enabled
                        }
                        onClick={() => setBanListOpen((open) => !open)}
                        disabled={saving}
                      >
                        Banned
                        {banList.bannedStrings.length > 0 &&
                          ` · ${banList.bannedStrings.length}`}
                        {banList.bannedStrings.length > 0 &&
                          !banList.enabled &&
                          " (off)"}
                      </button>
                      {banListOpen && (
                        <BanListPopover
                          bannedStrings={banList.bannedStrings}
                          enabled={banList.enabled}
                          onAdd={banList.addBannedString}
                          onRemoveAt={banList.removeBannedStringAt}
                          onToggleEnabled={banList.toggleEnabled}
                          onClose={() => setBanListOpen(false)}
                        />
                      )}
                    </div>
                  </>
                ) : workspaceMode === "autocomplete" ? (
                  <label className="bw-field">
                    Tokens per suggestion
                    <input
                      type="number"
                      min={1}
                      max={8}
                      value={branchControls.tokensPerSuggestionText}
                      onChange={(event) =>
                        branchControls.onTokensPerSuggestionChange(event.target.value)
                      }
                      onBlur={() => {
                        branchControls.normalizeTokensPerSuggestion();
                      }}
                      disabled={saving}
                      className="bw-input w-16"
                    />
                  </label>
                ) : null}
              </div>
              <div className="bw-action-main">
                {isChatProject && currentNode && (
                  <button
                    type="button"
                    className="bw-node-star"
                    data-on={chatTipStarred}
                    aria-pressed={chatTipStarred}
                    aria-label={
                      chatTipStarred
                        ? "Unstar this conversation"
                        : "Star this conversation"
                    }
                    title={
                      chatConversationNodes.length === 0
                        ? "Nothing to star yet — send a message first"
                        : chatTipStarred
                          ? "Unstar this conversation"
                          : "Star this conversation"
                    }
                    disabled={
                      // Disabled in an empty chat. The only path nodes there
                      // are the root/system preamble, which the conversation
                      // star must never write to.
                      saving || streaming || chatConversationNodes.length === 0
                    }
                    onClick={() => void onSetChatConversationStarred(!chatTipStarred)}
                  >
                    {chatTipStarred ? "★" : "☆"}
                  </button>
                )}
                {isChatProject && (
                  <button
                    type="button"
                    className="bw-button"
                    onClick={() => {
                      const text = buildChatTranscriptWithDrafts(
                        chatSystemDraft,
                        chatTurns,
                        chatTurnDrafts,
                      );
                      downloadTextFile(chatTranscriptFilename(projectTitle), text);
                    }}
                    disabled={chatConversationNodes.length === 0}
                    title={
                      chatConversationNodes.length === 0
                        ? "Nothing to export yet — send a message first"
                        : "Export this conversation as a .txt file"
                    }
                  >
                    Export .txt
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void onSave()}
                  disabled={saving || streaming || !dirtyBuffer}
                  data-dirty={dirtyBuffer}
                  className="bw-button"
                  title={
                    dirtyBuffer ? "Save unsaved buffer changes" : "Buffer is saved"
                  }
                >
                  {saving ? "Saving" : "Save"}
                </button>
                {isChatProject && streaming ? (
                  <button
                    type="button"
                    onClick={onCancel}
                    className="bw-button bw-button-primary"
                  >
                    Stop
                  </button>
                ) : isChatProject ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void onAddChatAssistantChunk()}
                      disabled={saving || streaming || !chatCanAddAssistantChunk}
                      className="bw-button"
                      title="Append an empty assistant chunk you can type into"
                    >
                      Add assistant
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        if (chatHasPendingUserDraft) {
                          void onSubmitChatUser();
                          return;
                        }
                        const committed = await commitChatDraftsAndPersist();
                        if (!committed) return;
                        void startChatAssistantGeneration(
                          committed.tree,
                          committed.currentId,
                        );
                      }}
                      disabled={
                        saving || !currentTabbyModel || !chatCanSubmitOrGenerate
                      }
                      className="bw-button bw-button-primary"
                      title={
                        chatHasPendingUserDraft
                          ? "Send message and generate reply"
                          : "Generate assistant branches"
                      }
                    >
                      {chatHasPendingUserDraft ? "Send" : "Generate"}
                    </button>
                  </>
                ) : workspaceMode === "compose" && streaming ? (
                  <button
                    type="button"
                    onClick={onCancel}
                    className="bw-button bw-button-primary"
                  >
                    Stop
                  </button>
                ) : workspaceMode === "compose" ? (
                  <button
                    type="button"
                    onClick={() => void onGenerate()}
                    disabled={saving || !currentTabbyModel}
                    className="bw-button bw-button-primary"
                    title="Generate branches (Cmd+Enter)"
                  >
                    Generate
                  </button>
                ) : null}
              </div>
            </footer>
          </main>
        </div>
      )}
    </div>
  );
}
