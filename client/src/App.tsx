import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  closeProject as closeProjectApi,
  createProject,
  createPreset,
  currentProject,
  currentModel,
  deletePreset,
  dialogPickNewProject,
  dialogPickProject,
  downloadModel,
  encodeTokens,
  getActivePreset,
  getProjectSettings,
  listModels,
  listNodes,
  listPresets,
  mutateNodes,
  openProject,
  setActivePreset,
  streamChatCompletion,
  streamCompletion,
  streamModelLoad,
  unloadModel,
  updateProjectSettings,
  updatePreset,
  type ChatCompletionMessage,
  type ChatRole,
  type ComposeDisplayMode,
  type ModelLoadEvent,
  type ModelLoadRequest,
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
import { mergePreset, neutralBody } from "./samplers/fields";
import { contextHash } from "./tree/hash";
import { loadedTreeFromModels, mutationBatchFromTrees } from "./tree/persistence";
import { reshape } from "./tree/reshape";
import {
  NODE_MAP_FIT_PADDING,
  NODE_MAP_MAX_SCALE,
  NODE_MAP_MINIMAP_MAX_HEIGHT,
  NODE_MAP_MINIMAP_MAX_WIDTH,
  NODE_MAP_MIN_SCALE,
  NODE_MAP_PAN_MARGIN,
  buildNodeMapLayout,
  displayBranchText,
  nodeLabel,
  previewText,
  sortedChildrenOf,
  type NodeMapLayout,
} from "./nodeMapLayout";
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

type Candidate = {
  text: string;
  done: boolean;
  finishReason: string | null;
};

type CandidateContext = "prose" | "chat";

type BranchViewMode = "grid" | "strip";

type WorkspaceMode = "compose" | "autocomplete" | "map";

type UsedCandidateRange = {
  start: number;
  end: number;
};

type LinearChain = {
  nodes: TreeNode[];
  successor: TreeNode | null;
};

type NodeMapMergeAnalysis =
  | { ok: true; orderedIds: string[] }
  | { ok: false; reason: string };

type NodeMapDrag = {
  pointerId: number;
  startX: number;
  startY: number;
  panX: number;
  panY: number;
  moved: boolean;
};

type NodeMapMarquee = {
  pointerId: number;
  startCanvas: { x: number; y: number };
  currentCanvas: { x: number; y: number };
  baseSelection: string[];
};

type MapTooltip = {
  text: string;
  x: number;
  y: number;
};

type AutocompleteState =
  | { phase: "idle" }
  | { phase: "thinking" }
  | { phase: "showing"; suggestions: string[]; visibleIdx: number };

type ChatTurn = {
  role: ChatRole;
  nodes: TreeNode[];
  text: string;
  endOfTurn: boolean;
};

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected error";
}

function parseGpuSplitInput(input: string): number[] {
  const trimmed = input.trim();
  if (!trimmed) return [];

  const values = trimmed.split(",").map((raw) => {
    const part = raw.trim();
    if (!part) {
      throw new Error("GPU split must be a comma-separated list of GB values.");
    }
    const value = Number(part);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("GPU split values must be non-negative numbers.");
    }
    return value;
  });

  if (!values.some((value) => value > 0)) {
    throw new Error("GPU split must reserve VRAM on at least one GPU.");
  }

  return values;
}

function nodeId(): string {
  return crypto.randomUUID();
}

function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

function approxTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function branchNode(
  parentId: string,
  text: string,
  source: NodeSource,
  hidden: boolean,
  priorText: string,
  modelId?: string,
  samplerSnapshot?: SamplerBody,
  role: ChatRole = "user",
  endOfTurn = false,
): TreeNode {
  return {
    id: nodeId(),
    parentId,
    text,
    name: null,
    source,
    role,
    endOfTurn,
    hidden,
    starred: false,
    createdAt: nowEpoch(),
    priorContextHash: contextHash(priorText),
    modelId,
    samplerSnapshot,
  };
}

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

function formatLoadEvent(event: ModelLoadEvent | null): string {
  if (!event) return "";
  return `${event.status} ${event.module}/${event.modules}`;
}

function analyzeNodeMapMergeSelection(
  tree: Tree,
  selectedIds: string[],
): NodeMapMergeAnalysis {
  const uniqueIds = [...new Set(selectedIds)].filter((id) => tree.nodes[id]);
  if (uniqueIds.length < 2) {
    return { ok: false, reason: "Select at least two connected nodes." };
  }

  const selected = new Set(uniqueIds);
  const upstreamIds = uniqueIds.filter((id) => {
    const parentId = tree.nodes[id]?.parentId;
    return parentId === null || !selected.has(parentId);
  });

  if (upstreamIds.length !== 1) {
    return { ok: false, reason: "Selection must be one linear parent-child run." };
  }

  const upstream = tree.nodes[upstreamIds[0]];
  if (!upstream || upstream.parentId === null) {
    return { ok: false, reason: "Root cannot be merged." };
  }

  const orderedIds: string[] = [];
  let current: TreeNode | undefined = upstream;
  while (current && selected.has(current.id)) {
    orderedIds.push(current.id);
    const allChildren = sortedChildrenOf(tree, current.id);
    const selectedChildren = allChildren.filter((child) => selected.has(child.id));
    if (selectedChildren.length === 0) break;
    if (selectedChildren.length > 1 || allChildren.length !== 1) {
      return {
        ok: false,
        reason: "Cannot merge through a node with multiple children.",
      };
    }
    current = selectedChildren[0];
  }

  if (orderedIds.length !== uniqueIds.length) {
    return { ok: false, reason: "Selection must be one linear parent-child run." };
  }

  return { ok: true, orderedIds };
}

function collectSubtreeNodeIds(tree: Tree, nodeIdToCollect: string): string[] {
  const collected: string[] = [];
  const stack = [nodeIdToCollect];
  while (stack.length > 0) {
    const nodeIdFromStack = stack.pop()!;
    if (!tree.nodes[nodeIdFromStack]) continue;
    collected.push(nodeIdFromStack);
    for (const child of childrenOf(tree, nodeIdFromStack)) {
      stack.push(child.id);
    }
  }
  return collected;
}

function clampNodeMapScale(scale: number): number {
  return Math.max(NODE_MAP_MIN_SCALE, Math.min(NODE_MAP_MAX_SCALE, scale));
}

function clampNodeMapPan(
  pan: { x: number; y: number },
  layout: NodeMapLayout,
  viewport: { width: number; height: number },
  scale: number,
): { x: number; y: number } {
  const contentWidth = layout.width * scale;
  const contentHeight = layout.height * scale;

  function clampAxis(value: number, viewportSize: number, contentSize: number) {
    if (contentSize <= viewportSize - NODE_MAP_PAN_MARGIN * 2) {
      return Math.round((viewportSize - contentSize) / 2);
    }
    const min = viewportSize - contentSize - NODE_MAP_PAN_MARGIN;
    const max = NODE_MAP_PAN_MARGIN;
    return Math.round(Math.min(max, Math.max(min, value)));
  }

  return {
    x: clampAxis(pan.x, viewport.width, contentWidth),
    y: clampAxis(pan.y, viewport.height, contentHeight),
  };
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

const DEFAULT_MAX_TOKENS = 256;
const DEFAULT_BRANCH_COUNT = 3;
const DEFAULT_BRANCH_LIMIT = 12;
const MAX_BRANCH_UI_LIMIT = 12;
const DEFAULT_TOKENS_PER_SUGGESTION = 2;
const AUTOCOMPLETE_POOL_TARGET = 10;
const DEFAULT_LOAD_MAX_SEQ_LEN = 65536;
const COMMON_CONTEXT_SIZES = "8192  |  16384  |  32768  |  65536  |  131072";
const COLLAPSED_RAIL_WIDTH = 40;
const SINGLE_ROW_BRANCH_PANE_RATIO = 0.5;
const TWO_ROW_BRANCH_PANE_RATIO = 0.65;
const MANY_ROW_BRANCH_PANE_RATIO = 0.75;

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

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
  const lastChar = prompt[prompt.length - 1];
  if (/\s/.test(lastChar)) return { trimmedPrompt: prompt, partial: "" };
  const start = Math.max(0, prompt.length - AUTOCOMPLETE_TRIM_WINDOW);
  let lastWsIdx = -1;
  for (let i = prompt.length - 1; i >= start; i--) {
    if (/\s/.test(prompt[i])) {
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

function parsePositiveInt(text: string, fallback: number): number {
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function maxBranchesForModel(model: TabbyModel | null): number {
  const maxBatchSize = model?.parameters?.max_batch_size;
  if (typeof maxBatchSize !== "number" || !Number.isFinite(maxBatchSize)) {
    return DEFAULT_BRANCH_LIMIT;
  }
  return clampNumber(Math.trunc(maxBatchSize), 1, MAX_BRANCH_UI_LIMIT);
}

function parseBranchCountInput(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return parsed > 0 ? parsed : null;
}

function branchGridColumns(count: number): number | null {
  const lookup: Record<number, number> = {
    1: 1,
    2: 2,
    3: 3,
    4: 2,
    5: 3,
    6: 3,
    7: 4,
    8: 4,
    9: 3,
  };
  return lookup[count] ?? null;
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
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [tree, setTree] = useState<Tree | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [buffer, setBuffer] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [candidateContext, setCandidateContext] = useState<CandidateContext>("prose");
  const [candidatePrompt, setCandidatePrompt] = useState<string | null>(null);
  const [candidateBaseId, setCandidateBaseId] = useState<string | null>(null);
  const [candidateModelId, setCandidateModelId] = useState<string | null>(null);
  const [candidateSamplerSnapshot, setCandidateSamplerSnapshot] =
    useState<SamplerBody | null>(null);
  const [savedCandidateIds, setSavedCandidateIds] = useState<Record<number, string>>(
    {},
  );
  const [branchCountText, setBranchCountText] = useState(String(DEFAULT_BRANCH_COUNT));
  const [branchLimitHint, setBranchLimitHint] = useState(false);
  const [branchCountError, setBranchCountError] = useState<string | null>(null);
  const [maxTokensText, setMaxTokensText] = useState(String(DEFAULT_MAX_TOKENS));
  const [maxTokensError, setMaxTokensError] = useState<string | null>(null);
  const [maxTokensLimitHint, setMaxTokensLimitHint] = useState(false);
  const [tokensPerSuggestionText, setTokensPerSuggestionText] = useState(
    String(DEFAULT_TOKENS_PER_SUGGESTION),
  );
  const [streaming, setStreaming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingProject, setLoadingProject] = useState(true);
  const [currentTabbyModel, setCurrentTabbyModel] = useState<TabbyModel | null>(null);
  const [availableModels, setAvailableModels] = useState<TabbyModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);
  const [modelPanelOpen, setModelPanelOpen] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelLoadEvent, setModelLoadEvent] = useState<ModelLoadEvent | null>(null);
  const [selectedModelName, setSelectedModelName] = useState("");
  const [loadMaxSeqLen, setLoadMaxSeqLen] = useState(DEFAULT_LOAD_MAX_SEQ_LEN);
  const [loadCacheMode, setLoadCacheMode] = useState("Q6");
  const [loadTensorParallel, setLoadTensorParallel] = useState(false);
  const [loadTensorParallelBackend, setLoadTensorParallelBackend] = useState<
    "native" | "nccl"
  >("native");
  const [loadGpuSplit, setLoadGpuSplit] = useState("");
  const [downloadRepoId, setDownloadRepoId] = useState(
    "lucyknada/google_gemma-3-270m-exl3",
  );
  const [downloadRevision, setDownloadRevision] = useState("6.0bpw");
  const [downloadFolder, setDownloadFolder] = useState("");
  const [tokenCount, setTokenCount] = useState<number | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [starredOnly, setStarredOnly] = useState(false);
  const [treeSearch, setTreeSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [presets, setPresets] = useState<SamplerPreset[]>([]);
  const [activePresetId, setActivePresetIdState] = useState<string | null>(null);
  const [draftBody, setDraftBody] = useState<SamplerBody>(() => neutralBody());
  const [samplerBusy, setSamplerBusy] = useState(false);
  const [samplerOpen, setSamplerOpen] = useState(false);
  const [treeMenu, setTreeMenu] = useState<TreeContextMenu | null>(null);
  const [collapsedNodes, setCollapsedNodes] = useState<Record<string, boolean>>({});
  const [expandedChains, setExpandedChains] = useState<Record<string, boolean>>({});
  const [branchViewMode, setBranchViewMode] = useState<BranchViewMode>("grid");
  const [visibleCandidateIndex, setVisibleCandidateIndex] = useState(0);
  const [composeDisplayMode, setComposeDisplayMode] =
    useState<ComposeDisplayMode>("cards");
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("compose");
  const [autocompleteState, setAutocompleteState] = useState<AutocompleteState>({
    phase: "idle",
  });
  const [autocompleteStatus, setAutocompleteStatus] = useState<string | null>(null);
  const [pickedCandidateIndex, setPickedCandidateIndex] = useState<number | null>(null);
  const [usedCandidateRange, setUsedCandidateRange] =
    useState<UsedCandidateRange | null>(null);
  const [branchPaneRatio, setBranchPaneRatio] = useState(SINGLE_ROW_BRANCH_PANE_RATIO);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [treeVisible, setTreeVisible] = useState(true);
  const [chatSystemExpanded, setChatSystemExpanded] = useState(false);
  const [chatSystemDraft, setChatSystemDraft] = useState("");
  const [chatUserDraft, setChatUserDraft] = useState("");
  const [chatTurnDrafts, setChatTurnDrafts] = useState<Record<string, string>>({});
  const [treeWidth, setTreeWidth] = useState(288);
  const [mapPan, setMapPan] = useState({ x: 0, y: 0 });
  const [mapScale, setMapScale] = useState(1);
  const [mapDragging, setMapDragging] = useState(false);
  const [mapLocateRequest, setMapLocateRequest] = useState(0);
  const [mapFitRequest, setMapFitRequest] = useState(0);
  const [mapSelectedId, setMapSelectedId] = useState<string | null>(null);
  const [mapSelectionIds, setMapSelectionIds] = useState<string[]>([]);
  const [mapViewportSize, setMapViewportSize] = useState({ width: 0, height: 0 });
  const [mapTooltip, setMapTooltip] = useState<MapTooltip | null>(null);
  const [mapShowHidden, setMapShowHidden] = useState(false);
  const [mapMarquee, setMapMarquee] = useState<NodeMapMarquee | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const autocompleteAbortRef = useRef<AbortController | null>(null);
  const editorRef = useRef<WorkbookEditorHandle | null>(null);
  const mapViewportRef = useRef<HTMLDivElement | null>(null);
  const mapDragRef = useRef<NodeMapDrag | null>(null);
  const mapMarqueeRef = useRef<NodeMapMarquee | null>(null);
  const mapSuppressClickRef = useRef(false);
  const lastHandledFitRequestRef = useRef(0);
  const lastHandledLocateRequestRef = useRef(0);
  const bufferSelectionRef = useRef<{ start: number; end: number } | null>(null);
  const bufferSelectionArmedRef = useRef(false);
  const preserveUsedRangeForBufferRef = useRef<string | null>(null);

  const branchPickerOpen = candidatePrompt !== null;
  const contextMax = modelContextMax(currentTabbyModel);
  const maxBranches = maxBranchesForModel(currentTabbyModel);
  const branchLimitMessage =
    maxBranches >= MAX_BRANCH_UI_LIMIT
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
  const currentPath = useMemo(
    () => (tree && currentId ? pathFromRoot(tree, currentId) : []),
    [tree, currentId],
  );
  const currentPathIds = useMemo(
    () => new Set(currentPath.map((node) => node.id)),
    [currentPath],
  );
  const nodeMapVisibleTree = useMemo(() => {
    if (!tree) return null;
    if (mapShowHidden) return tree;
    const keep = new Set<string>();
    const stack = [tree.rootId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      const node = tree.nodes[id];
      if (!node) continue;
      if (node.hidden && !currentPathIds.has(id)) continue;
      keep.add(id);
      for (const child of childrenOf(tree, id)) stack.push(child.id);
    }
    const nextNodes: typeof tree.nodes = {};
    for (const id of keep) {
      const node = tree.nodes[id];
      if (node) nextNodes[id] = node;
    }
    return { rootId: tree.rootId, nodes: nextNodes };
  }, [tree, mapShowHidden, currentPathIds]);
  const nodeMapLayout = useMemo(
    () => (nodeMapVisibleTree ? buildNodeMapLayout(nodeMapVisibleTree) : null),
    [nodeMapVisibleTree],
  );
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
    const scrollContainer = document.querySelector(
      ".bw-manuscript-scroll",
    ) as HTMLElement | null;
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

  const clearBranchPicker = useCallback(() => {
    setCandidates([]);
    setCandidateContext("prose");
    setCandidatePrompt(null);
    setCandidateBaseId(null);
    setCandidateModelId(null);
    setCandidateSamplerSnapshot(null);
    setSavedCandidateIds({});
    setPickedCandidateIndex(null);
    setUsedCandidateRange(null);
    setVisibleCandidateIndex(0);
    setBranchViewMode("grid");
  }, []);

  function dropCandidate(indexToDrop: number) {
    if (streaming || saving) return;
    const nextCandidates = candidates.filter((_, index) => index !== indexToDrop);
    if (nextCandidates.length === 0) {
      clearBranchPicker();
      return;
    }

    setCandidates(nextCandidates);
    setSavedCandidateIds((current) => {
      const next: Record<number, string> = {};
      for (const [rawIndex, nodeId] of Object.entries(current)) {
        const index = Number(rawIndex);
        if (!Number.isInteger(index) || index === indexToDrop) continue;
        next[index > indexToDrop ? index - 1 : index] = nodeId;
      }
      return next;
    });
    setPickedCandidateIndex((current) => {
      if (current === null) return null;
      if (current === indexToDrop) return null;
      return current > indexToDrop ? current - 1 : current;
    });
    setVisibleCandidateIndex((current) => {
      if (current === indexToDrop) {
        return Math.min(indexToDrop, nextCandidates.length - 1);
      }
      return Math.min(
        current > indexToDrop ? current - 1 : current,
        nextCandidates.length - 1,
      );
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
  }, []);

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

  const refreshModels = useCallback(async () => {
    setLoadingModels(true);
    try {
      const [current, models] = await Promise.all([currentModel(), listModels()]);
      setCurrentTabbyModel(current);
      setAvailableModels(models.data);
      setSelectedModelName((existing) => {
        if (existing) return existing;
        return current?.id ?? models.data[0]?.id ?? "";
      });
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoadingModels(false);
    }
  }, []);

  function applyProjectSettings(settings: {
    display_mode: ComposeDisplayMode;
    branch_count: number;
    max_tokens: number;
    tokens_per_suggestion: number;
  }) {
    setComposeDisplayMode(settings.display_mode);
    setBranchCountText(String(settings.branch_count));
    setMaxTokensText(String(settings.max_tokens));
    setTokensPerSuggestionText(String(settings.tokens_per_suggestion));
    setBranchLimitHint(false);
    setBranchCountError(null);
  }

  function saveProjectSettings(patch: ProjectSettingsPatch) {
    if (!project) return;
    void updateProjectSettings(patch)
      .then(() => {
        setError((current) =>
          current?.includes("/api/project/settings") ? null : current,
        );
      })
      .catch((err) => {
        setError(formatError(err));
      });
  }

  function resetRecordedSelectionToEnd(nextBuffer: string) {
    bufferSelectionRef.current = {
      start: nextBuffer.length,
      end: nextBuffer.length,
    };
    bufferSelectionArmedRef.current = false;
  }

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
      setProject(info);
      setTree(loaded.tree);
      setCurrentId(loaded.currentId);
      setBuffer(loadedBuffer);
      resetRecordedSelectionToEnd(loadedBuffer);
      setExpandedChains({});
      setWorkspaceMode(info.kind === "chat" ? "compose" : "compose");
      setChatUserDraft("");
      setChatTurnDrafts({});
      setChatSystemExpanded(false);
      setChatSystemDraft(
        pathFromRoot(loaded.tree, loaded.currentId).find(
          (node) => node.role === "system",
        )?.text ?? "",
      );
      applyProjectSettings(settings);
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
    [applyActivePreset, clearBranchPicker, refreshPresets],
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
  }, [loadProject]);

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

    const tokensPerSuggestion = clampNumber(
      parsePositiveInt(tokensPerSuggestionText, DEFAULT_TOKENS_PER_SUGGESTION),
      1,
      8,
    );
    const { trimmedPrompt, partial } = trimAutocompletePromptSuffix(buffer);
    const samplerSnapshot = mergePreset(draftBody);
    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      const abort = new AbortController();
      autocompleteAbortRef.current = abort;
      setAutocompleteState({ phase: "thinking" });
      setAutocompleteStatus(null);

      const partials = Array.from({ length: AUTOCOMPLETE_POOL_TARGET }, () => "");
      const slotsByIndex = Array.from({ length: AUTOCOMPLETE_POOL_TARGET }, () => -1);

      void streamCompletion(
        {
          prompt: trimmedPrompt,
          n: AUTOCOMPLETE_POOL_TARGET,
          max_tokens: tokensPerSuggestion,
          ...samplerSnapshot,
          ban_eos_token: true,
        },
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
              partials[choice.index],
              partial,
            );
            if (!suggestion) continue;

            setAutocompleteState((current) => {
              if (current.phase === "idle") return current;
              const suggestions =
                current.phase === "showing" ? [...current.suggestions] : [];
              let slot = slotsByIndex[choice.index];
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
    saving,
    streaming,
    tokensPerSuggestionText,
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
        setTree(reshaped.tree);
        setCurrentId(reshaped.currentId);
        setBuffer(nextBuffer);

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
      }
    },
    [buffer, currentId, project, saving, streaming, tree],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void commitBuffer();
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key === "Enter" &&
        workspaceMode === "compose" &&
        project?.kind !== "chat"
      ) {
        event.preventDefault();
        void onGenerate();
      }
      if (event.key === "Escape") {
        if (closeConfirmOpen) {
          setCloseConfirmOpen(false);
        } else if (modelPanelOpen) {
          setModelPanelOpen(false);
        } else if (samplerOpen) {
          setSamplerOpen(false);
        } else if (treeMenu) {
          setTreeMenu(null);
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    closeConfirmOpen,
    commitBuffer,
    modelPanelOpen,
    onGenerate,
    project?.kind,
    samplerOpen,
    treeMenu,
    workspaceMode,
  ]);

  useEffect(() => {
    if (!treeMenu) return;
    function onPointerDown() {
      setTreeMenu(null);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [treeMenu]);

  useEffect(() => {
    if (
      workspaceMode !== "map" ||
      !nodeMapLayout ||
      !currentId ||
      mapLocateRequest === 0
    ) {
      return;
    }
    if (lastHandledLocateRequestRef.current === mapLocateRequest) {
      return;
    }
    lastHandledLocateRequestRef.current = mapLocateRequest;

    const viewport = mapViewportRef.current;
    const targetId =
      mapSelectedId && tree?.nodes[mapSelectedId] ? mapSelectedId : currentId;
    const item = nodeMapLayout.nodes.find(
      (candidate) => candidate.node.id === targetId,
    );
    if (!viewport || !item) return;
    const scale = mapScale;

    setMapPan(
      clampNodeMapPan(
        {
          x: Math.round(viewport.clientWidth / 2 - (item.x + item.width / 2) * scale),
          y: Math.round(
            Math.min(
              96,
              viewport.clientHeight / 2 - (item.y + item.height / 2) * scale,
            ),
          ),
        },
        nodeMapLayout,
        { width: viewport.clientWidth, height: viewport.clientHeight },
        scale,
      ),
    );
  }, [
    currentId,
    mapLocateRequest,
    mapScale,
    mapSelectedId,
    nodeMapLayout,
    tree,
    workspaceMode,
  ]);

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
  }, [currentId, mapSelectedId, mapSelectionIds, tree]);

  useEffect(() => {
    if (workspaceMode !== "map") return;
    const viewport = mapViewportRef.current;
    if (!viewport) return;
    const observedViewport = viewport;

    function updateViewportSize() {
      const nextWidth = Math.round(observedViewport.clientWidth);
      const nextHeight = Math.round(observedViewport.clientHeight);
      setMapViewportSize((current) =>
        current.width === nextWidth && current.height === nextHeight
          ? current
          : { width: nextWidth, height: nextHeight },
      );
    }

    updateViewportSize();
    const resizeObserver = new ResizeObserver(updateViewportSize);
    resizeObserver.observe(observedViewport);
    return () => resizeObserver.disconnect();
  }, [workspaceMode]);

  useEffect(() => {
    if (workspaceMode !== "map" || !nodeMapLayout || mapFitRequest === 0) {
      return;
    }
    if (lastHandledFitRequestRef.current === mapFitRequest) {
      return;
    }
    lastHandledFitRequestRef.current = mapFitRequest;

    const viewport = mapViewportRef.current;
    if (!viewport) return;

    const availableWidth = Math.max(1, viewport.clientWidth - NODE_MAP_FIT_PADDING * 2);
    const availableHeight = Math.max(
      1,
      viewport.clientHeight - NODE_MAP_FIT_PADDING * 2,
    );
    const scale = clampNodeMapScale(
      Math.min(
        1,
        availableWidth / nodeMapLayout.width,
        availableHeight / nodeMapLayout.height,
      ),
    );

    setMapScale(scale);
    setMapPan(
      clampNodeMapPan(
        {
          x: Math.round((viewport.clientWidth - nodeMapLayout.width * scale) / 2),
          y: Math.round((viewport.clientHeight - nodeMapLayout.height * scale) / 2),
        },
        nodeMapLayout,
        { width: viewport.clientWidth, height: viewport.clientHeight },
        scale,
      ),
    );
  }, [mapFitRequest, nodeMapLayout, workspaceMode]);

  useEffect(() => {
    if (branchCountText.trim() === "") return;
    const parsed = parseBranchCountInput(branchCountText);
    if (parsed === null) return;
    const clamped = clampNumber(parsed, 1, maxBranches);
    if (clamped !== parsed) {
      setBranchCountText(String(clamped));
      setBranchLimitHint(true);
      setBranchCountError(null);
    }
    // Only normalize when the loaded model changes the allowed ceiling.
    // Normalizing on every keystroke would reintroduce the leading-zero bug.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxBranches]);

  useEffect(() => {
    function onMapKeyDown(event: KeyboardEvent) {
      if (workspaceMode !== "map") return;
      if (!(event.metaKey || event.ctrlKey)) return;

      if (event.key === "0") {
        event.preventDefault();
        setMapFitRequest((value) => value + 1);
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomNodeMap(1.12);
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        zoomNodeMap(1 / 1.12);
      }
    }

    window.addEventListener("keydown", onMapKeyDown);
    return () => window.removeEventListener("keydown", onMapKeyDown);
  });

  useEffect(() => {
    setVisibleCandidateIndex((current) =>
      candidates.length === 0 ? 0 : Math.min(current, candidates.length - 1),
    );
  }, [candidates.length]);

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

  async function onCreateProject(kind: "prose" | "chat" = "prose") {
    setError(null);
    let chosen: string | null;
    try {
      const picked = await dialogPickNewProject();
      chosen = picked.path;
    } catch (err) {
      setError(formatError(err));
      return;
    }
    if (!chosen) return;

    setLoadingProject(true);
    try {
      const info = await createProject(chosen, titleFromPath(chosen), kind);
      await loadProject(info);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoadingProject(false);
    }
  }

  async function onOpenProject() {
    setError(null);
    let chosen: string | null;
    try {
      const picked = await dialogPickProject();
      chosen = picked.path;
    } catch (err) {
      setError(formatError(err));
      return;
    }
    if (!chosen) return;

    setLoadingProject(true);
    try {
      const info = await openProject(chosen);
      await loadProject(info);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoadingProject(false);
    }
  }

  async function onCloseProject() {
    abortRef.current?.abort();
    setLoadingProject(true);
    setError(null);
    setCloseConfirmOpen(false);
    try {
      await closeProjectApi();
      setProject(null);
      setTree(null);
      setCurrentId(null);
      setBuffer("");
      resetRecordedSelectionToEnd("");
      setExpandedChains({});
      setChatUserDraft("");
      setChatTurnDrafts({});
      setChatSystemDraft("");
      setChatSystemExpanded(false);
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
    if (project.kind === "chat") return false;
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
    await commitBuffer();
  }

  async function onRefreshModels() {
    setError(null);
    await refreshModels();
  }

  async function onLoadModel(modelName = selectedModelName) {
    const trimmedModelName = modelName.trim();
    if (!trimmedModelName || modelBusy) return;

    setModelBusy(true);
    setModelLoadEvent(null);
    setError(null);
    try {
      const gpuSplit = parseGpuSplitInput(loadGpuSplit);
      const loadRequest: ModelLoadRequest = {
        model_name: trimmedModelName,
        max_seq_len: Math.max(
          256,
          Math.trunc(loadMaxSeqLen) || DEFAULT_LOAD_MAX_SEQ_LEN,
        ),
        cache_mode: loadCacheMode,
      };

      if (loadTensorParallel) {
        loadRequest.tensor_parallel = true;
        loadRequest.tensor_parallel_backend = loadTensorParallelBackend;
      }

      if (gpuSplit.length > 0) {
        loadRequest.gpu_split = gpuSplit;
        loadRequest.gpu_split_auto = false;
      }

      await streamModelLoad(loadRequest, setModelLoadEvent);
      await refreshModels();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setModelBusy(false);
    }
  }

  async function onUnloadModel() {
    if (modelBusy || !currentTabbyModel) return;

    setModelBusy(true);
    setModelLoadEvent(null);
    setError(null);
    try {
      await unloadModel();
      setCurrentTabbyModel(null);
      setTokenCount(null);
      await refreshModels();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setModelBusy(false);
    }
  }

  async function onDownloadModel(event: FormEvent) {
    event.preventDefault();
    const repoId = downloadRepoId.trim();
    if (!repoId || modelBusy) return;

    setModelBusy(true);
    setModelLoadEvent(null);
    setError(null);
    try {
      await downloadModel({
        repo_id: repoId,
        revision: downloadRevision.trim() || undefined,
        folder_name: downloadFolder.trim() || undefined,
      });
      await refreshModels();
      setSelectedModelName(downloadFolder.trim() || repoId.split("/").at(-1) || "");
    } catch (err) {
      setError(formatError(err));
    } finally {
      setModelBusy(false);
    }
  }

  async function onSelectNode(nodeIdToSelect: string) {
    if (!tree || !currentId || streaming || saving) return;

    const committed =
      project?.kind === "chat" ? { tree, currentId, buffer } : await commitBuffer();
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

    setSaving(true);
    setError(null);
    try {
      await mutateNodes({ main_path: path.map((node) => node.id) });
      setTree(committed.tree);
      setCurrentId(targetId);
      setBuffer(nextBuffer);
      resetRecordedSelectionToEnd(nextBuffer);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSaving(false);
    }
  }

  function normalizeBranchCount(): number | null {
    const parsed = parseBranchCountInput(branchCountText);
    if (parsed === null) {
      setBranchLimitHint(false);
      setBranchCountError(`Enter 1-${maxBranches} branches.`);
      return null;
    }
    const clamped = clampNumber(parsed, 1, maxBranches);
    setBranchCountText(String(clamped));
    setBranchLimitHint(parsed > maxBranches);
    setBranchCountError(null);
    saveProjectSettings({ branch_count: clamped });
    return clamped;
  }

  function normalizeMaxTokens(): number {
    const trimmed = maxTokensText.trim();
    const parsed = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : NaN;
    // The visual cap mirrors the loaded model's context length when known so
    // a typo like 999999 doesn't ship a request the backend will silently
    // truncate or reject. With no model loaded, fall back to a generous but
    // sane upper bound rather than letting unbounded values through.
    const ceiling = contextMax ?? 32768;
    if (!Number.isFinite(parsed) || parsed < 1) {
      // Empty/garbage: snap to default and flag, mirroring the Branches input
      // pattern so the user sees what value will actually be sent.
      setMaxTokensText(String(DEFAULT_MAX_TOKENS));
      setMaxTokensError(`Enter 1-${ceiling.toLocaleString()} tokens.`);
      setMaxTokensLimitHint(false);
      saveProjectSettings({ max_tokens: DEFAULT_MAX_TOKENS });
      return DEFAULT_MAX_TOKENS;
    }
    const clamped = Math.min(parsed, ceiling);
    setMaxTokensText(String(clamped));
    setMaxTokensLimitHint(parsed > ceiling);
    setMaxTokensError(null);
    saveProjectSettings({ max_tokens: clamped });
    return clamped;
  }

  function normalizeTokensPerSuggestion(): number {
    const normalized = clampNumber(
      parsePositiveInt(tokensPerSuggestionText, DEFAULT_TOKENS_PER_SUGGESTION),
      1,
      8,
    );
    setTokensPerSuggestionText(String(normalized));
    saveProjectSettings({ tokens_per_suggestion: normalized });
    return normalized;
  }

  async function onGenerate() {
    if (streaming || saving) return;
    if (!currentTabbyModel) {
      setError("Load a model before generating.");
      return;
    }

    const committed = await commitBuffer(buffer, "user_written");
    if (!committed) return;

    const n = normalizeBranchCount();
    if (n === null) return;
    const resolvedMaxTokens = normalizeMaxTokens();
    const promptSnapshot = committed.buffer;
    // Resolve the sampler snapshot *now* so a user tweaking the drawer
    // mid-stream doesn't retroactively change what a persisted node says
    // produced it.
    const samplerSnapshot = mergePreset(draftBody);
    const restoreManuscriptScroll = pinManuscriptScroll();
    setCandidates(
      Array.from({ length: n }, () => ({
        text: "",
        done: false,
        finishReason: null,
      })),
    );
    setCandidateContext("prose");
    setCandidatePrompt(promptSnapshot);
    setCandidateBaseId(committed.currentId);
    setCandidateModelId(currentTabbyModel.id);
    setCandidateSamplerSnapshot(samplerSnapshot);
    setSavedCandidateIds({});
    setPickedCandidateIndex(null);
    setUsedCandidateRange(null);
    setVisibleCandidateIndex(0);
    setBranchViewMode("grid");
    setBranchPaneRatio(branchPaneRatioForCount(n));
    setError(null);
    setStreaming(true);
    restoreManuscriptScroll();
    abortRef.current = new AbortController();
    let firstVisibleChosen = false;

    try {
      await streamCompletion(
        {
          prompt: promptSnapshot,
          n,
          max_tokens: resolvedMaxTokens,
          ...samplerSnapshot,
        },
        (chunk) => {
          for (const choice of chunk.choices) {
            if (choice.index < 0 || choice.index >= n || !choice.text) continue;
            if (!firstVisibleChosen) {
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
                text: existing.text + choice.text,
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

  function cycleVisibleCandidate(delta: 1 | -1): boolean {
    if (!branchPickerOpen || candidates.length <= 1) return false;
    setVisibleCandidateIndex(
      (current) => (current + delta + candidates.length) % candidates.length,
    );
    return true;
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
    if (singleLine.length < partial.length) {
      return singleLine.length === 0 || partial.startsWith(singleLine)
        ? null // still streaming; not enough chars to judge
        : null; // diverged from the user's prefix
    }
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

    const text = candidates[index]?.text ?? "";
    if (!text) {
      setError("Select a branch with text before using it.");
      return;
    }

    const canReplaceUsed = usedCandidateRange !== null;
    // Inline compose pins insertion to the end of the document. The ghost
    // preview is rendered at end-of-doc, and clicking "Use" while the
    // editor isn't focused would otherwise pull the cursor to a stale
    // selection — sometimes way above the visible region.
    const selection = bufferSelectionArmedRef.current
      ? bufferSelectionRef.current
      : null;
    const useEnd =
      !canReplaceUsed && (composeDisplayMode === "inline" || selection === null);
    const start = canReplaceUsed
      ? Math.max(0, Math.min(buffer.length, usedCandidateRange.start))
      : useEnd
        ? buffer.length
        : Math.max(0, Math.min(buffer.length, selection?.start ?? buffer.length));
    const end = canReplaceUsed
      ? Math.max(start, Math.min(buffer.length, usedCandidateRange.end))
      : useEnd
        ? buffer.length
        : Math.max(start, Math.min(buffer.length, selection?.end ?? start));
    const nextBuffer = `${buffer.slice(0, start)}${text}${buffer.slice(end)}`;
    const nextCursor = start + text.length;

    // The buffer lives inside .bw-manuscript-scroll (overflow:auto), not the
    // window. When setBuffer triggers CodeMirror's wholesale doc replace the
    // editor's caret is dispatched at the prior selection head — typically
    // offset 0 if the user clicked "Use" without first focusing the editor —
    // and the contenteditable's caret-into-view behavior yanks the scroll
    // container to the top. Snapshot scrollTop here and restore it after the
    // dispatch settles.
    const scrollContainer = document.querySelector(
      ".bw-manuscript-scroll",
    ) as HTMLElement | null;
    const scrollTopBefore = scrollContainer?.scrollTop ?? null;

    preserveUsedRangeForBufferRef.current = nextBuffer;
    setBuffer(nextBuffer);
    bufferSelectionArmedRef.current = true;
    bufferSelectionRef.current = { start: nextCursor, end: nextCursor };
    setUsedCandidateRange({ start, end: nextCursor });
    setPickedCandidateIndex(index);
    setBranchViewMode("strip");
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

    const text = candidates[index]?.text ?? "";
    if (!text) {
      setError("Select a branch with text before keeping it.");
      return;
    }
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

    setSaving(true);
    setError(null);
    try {
      await mutateNodes(mutationBatchFromTrees(tree, nextTree, currentId));
      setTree(nextTree);
      setSavedCandidateIds((current) => ({ ...current, [index]: node.id }));
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSaving(false);
    }
  }

  const chatPathNodes = currentPath.filter((node) => node.parentId !== null);
  const chatTurns = useMemo<ChatTurn[]>(() => {
    const turns: ChatTurn[] = [];
    for (const node of chatPathNodes) {
      const previous = turns[turns.length - 1];
      if (!previous || previous.role !== node.role || previous.endOfTurn) {
        turns.push({
          role: node.role,
          nodes: [node],
          text: node.text,
          endOfTurn: node.endOfTurn,
        });
      } else {
        previous.nodes.push(node);
        previous.text += node.text;
        previous.endOfTurn = node.endOfTurn;
      }
    }
    return turns;
  }, [chatPathNodes]);
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
    project?.kind === "chat" &&
    !branchPickerOpen &&
    (chatTailNode?.role === "user" ||
      (chatTailNode?.role === "assistant" && !chatTailNode.endOfTurn));
  const chatHasPendingUserDraft = chatCanComposeUser && chatUserDraft.trim().length > 0;
  const chatCanSubmitOrGenerate = chatCanGenerateAssistant || chatHasPendingUserDraft;
  const currentNode = tree && currentId ? tree.nodes[currentId] : null;
  const dirtyBuffer =
    project !== null &&
    project.kind !== "chat" &&
    tree !== null &&
    currentId !== null &&
    buffer !== concatPathText(currentPath);
  const emptyDraftStartsFromRoot =
    project !== null && currentPath.length > 1 && buffer.trim().length === 0;

  useEffect(() => {
    if (project?.kind !== "chat") return;
    setChatSystemDraft(chatSystemNode?.text ?? "");
  }, [chatSystemNode?.id, chatSystemNode?.text, project?.kind]);

  function buildChatPayload(path: TreeNode[]): {
    messages: ChatCompletionMessage[];
    responsePrefix: string | undefined;
  } {
    const turns: ChatTurn[] = [];
    for (const node of path.filter((item) => item.parentId !== null)) {
      const previous = turns[turns.length - 1];
      if (!previous || previous.role !== node.role || previous.endOfTurn) {
        turns.push({
          role: node.role,
          nodes: [node],
          text: node.text,
          endOfTurn: node.endOfTurn,
        });
      } else {
        previous.nodes.push(node);
        previous.text += node.text;
        previous.endOfTurn = node.endOfTurn;
      }
    }

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
      return true;
    } catch (err) {
      setError(formatError(err));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function onSaveChatSystem() {
    if (!tree || !currentId || !chatSystemNode || saving || streaming) return;
    if (chatSystemDraft === chatSystemNode.text) return;
    const nextTree: Tree = {
      rootId: tree.rootId,
      nodes: {
        ...tree.nodes,
        [chatSystemNode.id]: {
          ...chatSystemNode,
          text: chatSystemDraft,
          endOfTurn: true,
        },
      },
    };
    await persistChatTree(tree, nextTree, currentId);
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

    const n = normalizeBranchCount();
    if (n === null) return;
    const resolvedMaxTokens = normalizeMaxTokens();
    const samplerSnapshot = mergePreset(draftBody);
    const promptSnapshot = concatPathText(basePath);
    const { messages, responsePrefix } = buildChatPayload(basePath);

    setCandidates(
      Array.from({ length: n }, () => ({
        text: "",
        done: false,
        finishReason: null,
      })),
    );
    setCandidateContext("chat");
    setCandidatePrompt(promptSnapshot);
    setCandidateBaseId(baseId);
    setCandidateModelId(currentTabbyModel.id);
    setCandidateSamplerSnapshot(samplerSnapshot);
    setSavedCandidateIds({});
    setPickedCandidateIndex(null);
    setUsedCandidateRange(null);
    setVisibleCandidateIndex(0);
    setBranchViewMode("grid");
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
    if (!tree.nodes[currentId]) return;

    const priorText = concatPathText(pathFromRoot(tree, currentId));
    const node: TreeNode = {
      id: nodeId(),
      parentId: currentId,
      text,
      name: null,
      source: "user_written",
      role: "user",
      endOfTurn: true,
      hidden: false,
      starred: false,
      createdAt: nowEpoch(),
      priorContextHash: contextHash(priorText),
    };
    const nextTree: Tree = {
      rootId: tree.rootId,
      nodes: {
        ...tree.nodes,
        [node.id]: node,
      },
    };
    const saved = await persistChatTree(tree, nextTree, node.id);
    if (!saved) return;
    setChatUserDraft("");
    void startChatAssistantGeneration(nextTree, node.id);
  }

  async function onSaveChatTurn(turn: ChatTurn, nextText: string) {
    if (!tree || !currentId || project?.kind !== "chat" || saving || streaming) return;
    const text = nextText;
    if (text === turn.text) return;
    if (!text.trim()) {
      setError("Chat turns cannot be empty.");
      setChatTurnDrafts((current) => {
        const next = { ...current };
        const key = turn.nodes[0]?.id;
        if (key) next[key] = turn.text;
        return next;
      });
      return;
    }

    const firstNode = turn.nodes[0];
    if (!firstNode || firstNode.parentId === null) return;

    const canUpdateInPlace =
      turn.nodes.length === 1 && childrenOf(tree, firstNode.id).length === 0;

    if (canUpdateInPlace) {
      const nextTree: Tree = {
        rootId: tree.rootId,
        nodes: {
          ...tree.nodes,
          [firstNode.id]: {
            ...firstNode,
            text,
            endOfTurn: turn.role === "user" ? true : firstNode.endOfTurn,
          },
        },
      };
      await persistChatTree(tree, nextTree, currentId);
      setChatTurnDrafts((current) => {
        const next = { ...current };
        delete next[firstNode.id];
        return next;
      });
      return;
    }

    const priorText = concatPathText(pathFromRoot(tree, firstNode.parentId));
    const fork: TreeNode = {
      id: nodeId(),
      parentId: firstNode.parentId,
      text,
      name: null,
      source: turn.role === "assistant" ? "composed" : "user_written",
      role: turn.role,
      endOfTurn: turn.role === "user",
      hidden: false,
      starred: false,
      createdAt: nowEpoch(),
      priorContextHash: contextHash(priorText),
    };
    const nextTree: Tree = {
      rootId: tree.rootId,
      nodes: {
        ...tree.nodes,
        [fork.id]: fork,
      },
    };
    const saved = await persistChatTree(tree, nextTree, fork.id);
    if (saved) {
      setChatTurnDrafts({});
      clearBranchPicker();
    }
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
    const base = tree.nodes[candidateBaseId];
    if (!base) {
      setError("The generation base no longer exists.");
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
      rootId: tree.rootId,
      nodes: {
        ...tree.nodes,
        [node.id]: node,
      },
    };
    const saved = await persistChatTree(tree, nextTree, node.id);
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
      "assistant",
      candidates[index]?.finishReason === "stop",
    );
    const nextTree: Tree = {
      rootId: tree.rootId,
      nodes: {
        ...tree.nodes,
        [node.id]: node,
      },
    };
    setSaving(true);
    setError(null);
    try {
      await mutateNodes(mutationBatchFromTrees(tree, nextTree, currentId));
      setTree(nextTree);
      setSavedCandidateIds((current) => ({ ...current, [index]: node.id }));
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

  // Starred lineage: nodes worth showing when "Only starred paths" is on.
  // A node is on the starred lineage if it is starred, an ancestor of a
  // starred node, or a descendant of one — i.e., the full path passing
  // through any star. If nothing is starred, the filter is a no-op so the
  // user isn't locked out of the tree.
  const starredLineageIds = useMemo<Set<string> | null>(() => {
    if (!tree) return null;
    const starredIds = Object.values(tree.nodes)
      .filter((node) => node.starred)
      .map((node) => node.id);
    if (starredIds.length === 0) return null;

    const lineage = new Set<string>();
    // Ancestors of every starred node.
    for (const id of starredIds) {
      let cur: string | null | undefined = id;
      while (cur && !lineage.has(cur)) {
        lineage.add(cur);
        cur = tree.nodes[cur]?.parentId ?? null;
      }
    }
    // Descendants of every starred node.
    const childrenByParent: Record<string, string[]> = {};
    for (const node of Object.values(tree.nodes)) {
      if (node.parentId === null) continue;
      (childrenByParent[node.parentId] ??= []).push(node.id);
    }
    const stack = [...starredIds];
    while (stack.length > 0) {
      const id = stack.pop()!;
      for (const childId of childrenByParent[id] ?? []) {
        if (lineage.has(childId)) continue;
        lineage.add(childId);
        stack.push(childId);
      }
    }
    return lineage;
  }, [tree]);

  // Search lineage: nodes worth showing when a search query is active. A
  // node passes if its label (name or text preview) contains the query, or
  // if it's an ancestor or descendant of one that does — same shape as the
  // starred filter. Empty query → null (filter is a no-op).
  const searchMatchIds = useMemo<Set<string> | null>(() => {
    if (!tree) return null;
    const query = treeSearch.trim().toLowerCase();
    if (query.length === 0) return null;
    return new Set(
      Object.values(tree.nodes)
        .filter((node) => nodeLabel(node).toLowerCase().includes(query))
        .map((node) => node.id),
    );
  }, [tree, treeSearch]);

  const searchLineageIds = useMemo<Set<string> | null>(() => {
    if (!tree || searchMatchIds === null) return null;
    if (searchMatchIds.size === 0) return new Set<string>();

    const lineage = new Set<string>();
    for (const id of searchMatchIds) {
      let cur: string | null | undefined = id;
      while (cur && !lineage.has(cur)) {
        lineage.add(cur);
        cur = tree.nodes[cur]?.parentId ?? null;
      }
    }
    const childrenByParent: Record<string, string[]> = {};
    for (const node of Object.values(tree.nodes)) {
      if (node.parentId === null) continue;
      (childrenByParent[node.parentId] ??= []).push(node.id);
    }
    const stack = [...searchMatchIds];
    while (stack.length > 0) {
      const id = stack.pop()!;
      for (const childId of childrenByParent[id] ?? []) {
        if (lineage.has(childId)) continue;
        lineage.add(childId);
        stack.push(childId);
      }
    }
    return lineage;
  }, [searchMatchIds, tree]);
  const searchMatchCount = searchMatchIds?.size ?? null;
  const hasStarredNodes =
    tree !== null && Object.values(tree.nodes).some((node) => node.starred);
  const activeHiddenByFilters =
    tree !== null &&
    currentId !== null &&
    ((starredOnly && starredLineageIds !== null && !starredLineageIds.has(currentId)) ||
      (searchLineageIds !== null && !searchLineageIds.has(currentId)));
  const searchHasNoMatches = searchMatchCount === 0;
  const treeFilterNote = searchHasNoMatches
    ? "No node names match this search. Showing your current path for context."
    : starredOnly && !hasStarredNodes
      ? "No starred nodes yet. Star a node to use this filter."
      : activeHiddenByFilters
        ? "Current path is pinned because filters would otherwise hide it."
        : null;
  const isChatProject = project?.kind === "chat";
  const visibleCandidate = candidates[visibleCandidateIndex] ?? null;
  const showInlineCandidateControls =
    !isChatProject &&
    workspaceMode === "compose" &&
    candidateContext === "prose" &&
    composeDisplayMode === "inline" &&
    branchPickerOpen &&
    branchViewMode === "grid" &&
    visibleCandidate !== null;
  const editorKeyBindings = useMemo<KeyBinding[]>(
    () => [
      {
        key: "Tab",
        run: () => {
          if (acceptAutocompleteSuggestion()) return true;
          if (
            workspaceMode === "compose" &&
            composeDisplayMode === "inline" &&
            branchPickerOpen &&
            branchViewMode === "grid"
          ) {
            onUseCandidate(visibleCandidateIndex);
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
              ? cycleVisibleCandidate(1)
              : false,
      },
      {
        key: "Ctrl-[",
        run: () =>
          workspaceMode === "autocomplete"
            ? cycleAutocomplete(-1)
            : composeDisplayMode === "inline"
              ? cycleVisibleCandidate(-1)
              : false,
      },
    ],
    [
      autocompleteState.phase,
      autocompleteSuggestion,
      branchPickerOpen,
      branchViewMode,
      clearBranchPicker,
      composeDisplayMode,
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

    setSaving(true);
    setError(null);
    try {
      await mutateNodes(mutationBatchFromTrees(tree, nextTree, currentId));
      setTree(nextTree);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSaving(false);
    }
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

    setSaving(true);
    setError(null);
    try {
      await mutateNodes(mutationBatchFromTrees(tree, nextTree, currentId));
      setTree(nextTree);
      if (hidden && nodeIdToUpdate === currentId) {
        setShowHidden(true);
      }
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSaving(false);
      setTreeMenu(null);
    }
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

    setSaving(true);
    setError(null);
    try {
      await mutateNodes(mutationBatchFromTrees(tree, nextTree, currentId));
      setTree(nextTree);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSaving(false);
      setTreeMenu(null);
    }
  }

  async function persistTreeEdit(
    beforeTree: Tree,
    nextTree: Tree,
    nextCurrentId: string,
    nextSelectedId = nextCurrentId,
  ) {
    const nextPath = pathFromRoot(nextTree, nextCurrentId);
    const nextBuffer = concatPathText(nextPath);

    setSaving(true);
    setError(null);
    try {
      await mutateNodes(mutationBatchFromTrees(beforeTree, nextTree, nextCurrentId));
      setTree(nextTree);
      setCurrentId(nextCurrentId);
      setMapSelectedId(nextSelectedId);
      setMapSelectionIds([nextSelectedId]);
      setBuffer(nextBuffer);
      resetRecordedSelectionToEnd(nextBuffer);
      setMapLocateRequest((value) => value + 1);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSaving(false);
    }
  }

  async function onDeleteMapNode(nodeIdToDeleteFromMap: string) {
    if (!tree || !currentId || saving || streaming) return;

    const committed = await commitBuffer();
    if (!committed) return;

    const node = committed.tree.nodes[nodeIdToDeleteFromMap];
    if (!node || node.parentId === null) return;

    const idsToDelete = new Set(collectSubtreeNodeIds(committed.tree, node.id));
    const nextNodes = { ...committed.tree.nodes };
    for (const nodeIdToDelete of idsToDelete) {
      delete nextNodes[nodeIdToDelete];
    }

    const fallbackId = nextNodes[node.parentId] ? node.parentId : committed.tree.rootId;
    const nextCurrentId = idsToDelete.has(committed.currentId)
      ? fallbackId
      : committed.currentId;
    const nextTree: Tree = {
      rootId: committed.tree.rootId,
      nodes: nextNodes,
    };

    await persistTreeEdit(committed.tree, nextTree, nextCurrentId, fallbackId);
  }

  function buildMergedTree(
    baseTree: Tree,
    upstreamId: string,
    downstreamId: string,
  ): Tree | null {
    const upstream = baseTree.nodes[upstreamId];
    const downstream = baseTree.nodes[downstreamId];
    if (!upstream || !downstream || downstream.parentId !== upstream.id) return null;
    if (upstream.parentId === null) return null;
    if (childrenOf(baseTree, upstream.id).length !== 1) return null;

    const nextNodes = { ...baseTree.nodes };
    const merged: TreeNode = {
      ...upstream,
      text: `${upstream.text}${downstream.text}`,
      name: upstream.name ?? downstream.name ?? null,
      source: upstream.source === downstream.source ? upstream.source : "composed",
      starred: upstream.starred || downstream.starred,
    };

    for (const child of childrenOf(baseTree, downstream.id)) {
      nextNodes[child.id] = { ...child, parentId: upstream.id };
    }
    nextNodes[upstream.id] = merged;
    delete nextNodes[downstream.id];

    return {
      rootId: baseTree.rootId,
      nodes: nextNodes,
    };
  }

  function buildMergedSelectionTree(baseTree: Tree, orderedIds: string[]): Tree | null {
    const analysis = analyzeNodeMapMergeSelection(baseTree, orderedIds);
    if (!analysis.ok) return null;

    const orderedNodes = analysis.orderedIds.map((id) => baseTree.nodes[id]);
    const upstream = orderedNodes[0];
    const downstream = orderedNodes[orderedNodes.length - 1];
    if (!upstream || !downstream) return null;

    const nextNodes = { ...baseTree.nodes };
    const firstSource = upstream.source;
    const sameSource = orderedNodes.every((node) => node.source === firstSource);
    const merged: TreeNode = {
      ...upstream,
      text: orderedNodes.map((node) => node.text).join(""),
      name: orderedNodes.find((node) => node.name?.trim())?.name ?? null,
      source: sameSource ? firstSource : "composed",
      starred: orderedNodes.some((node) => node.starred),
      hidden: orderedNodes.every((node) => node.hidden),
    };

    for (const child of childrenOf(baseTree, downstream.id)) {
      nextNodes[child.id] = { ...child, parentId: upstream.id };
    }
    nextNodes[upstream.id] = merged;
    for (const node of orderedNodes.slice(1)) {
      delete nextNodes[node.id];
    }

    return {
      rootId: baseTree.rootId,
      nodes: nextNodes,
    };
  }

  async function onMergeNodeIntoParent(nodeIdToMerge: string) {
    if (!tree || !currentId || saving || streaming) return;

    const committed = await commitBuffer();
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

    const committed = await commitBuffer();
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

  async function onMergeMapSelection(selectedIdsToMerge: string[]) {
    if (!tree || !currentId || saving || streaming) return;

    const committed = await commitBuffer();
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

    const upstreamId = analysis.orderedIds[0];
    const deletedIds = new Set(analysis.orderedIds.slice(1));
    const nextCurrentId = deletedIds.has(committed.currentId)
      ? upstreamId
      : committed.currentId;
    await persistTreeEdit(committed.tree, nextTree, nextCurrentId, upstreamId);
  }

  async function onDeleteMapSelection(selectedIdsToDelete: string[]) {
    if (!tree || !currentId || saving || streaming) return;

    const committed = await commitBuffer();
    if (!committed) return;

    const eligible = selectedIdsToDelete.filter(
      (id) => committed.tree.nodes[id] && committed.tree.nodes[id].parentId !== null,
    );
    if (eligible.length === 0) return;

    const idsToDelete = new Set<string>();
    for (const id of eligible) {
      for (const subId of collectSubtreeNodeIds(committed.tree, id)) {
        idsToDelete.add(subId);
      }
    }

    const nextNodes = { ...committed.tree.nodes };
    for (const id of idsToDelete) {
      delete nextNodes[id];
    }

    let fallbackId = committed.tree.rootId;
    const firstEligibleParent = committed.tree.nodes[eligible[0]]?.parentId;
    if (firstEligibleParent && nextNodes[firstEligibleParent]) {
      fallbackId = firstEligibleParent;
    }
    const nextCurrentId = idsToDelete.has(committed.currentId)
      ? fallbackId
      : committed.currentId;
    const nextTree: Tree = { rootId: committed.tree.rootId, nodes: nextNodes };

    await persistTreeEdit(committed.tree, nextTree, nextCurrentId, fallbackId);
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

    setSaving(true);
    setError(null);
    try {
      await mutateNodes(mutationBatchFromTrees(tree, nextTree, currentId));
      setTree(nextTree);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSaving(false);
    }
  }

  async function onSetMainThread(nodeIdToPromote: string) {
    setTreeMenu(null);
    await onSelectNode(nodeIdToPromote);
  }

  function visibleTreeChildren(node: TreeNode): TreeNode[] {
    if (!tree) return [];
    return childrenOf(tree, node.id)
      .filter((child) => showHidden || !child.hidden || currentPathIds.has(child.id))
      .filter(
        (child) =>
          !starredOnly ||
          starredLineageIds === null ||
          starredLineageIds.has(child.id) ||
          currentPathIds.has(child.id),
      )
      .filter(
        (child) =>
          searchLineageIds === null ||
          searchLineageIds.has(child.id) ||
          currentPathIds.has(child.id),
      )
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  function visibleTreeNodeCount(): number {
    if (!tree) return 0;
    return Object.values(tree.nodes).filter((node) => {
      if (node.parentId === null) return true;
      if (!showHidden && node.hidden && !currentPathIds.has(node.id)) return false;
      if (
        starredOnly &&
        starredLineageIds !== null &&
        !starredLineageIds.has(node.id) &&
        !currentPathIds.has(node.id)
      ) {
        return false;
      }
      if (
        searchLineageIds !== null &&
        !searchLineageIds.has(node.id) &&
        !currentPathIds.has(node.id)
      ) {
        return false;
      }
      return true;
    }).length;
  }

  function isLinearChainBoundary(node: TreeNode, childNodes: TreeNode[]): boolean {
    return (
      node.id === tree?.rootId ||
      node.id === currentId ||
      node.hidden ||
      node.starred ||
      !!node.name?.trim() ||
      childNodes.length > 1
    );
  }

  function collectLinearChain(startNodeId: string): LinearChain | null {
    if (!tree || treeSearch.trim()) return null;

    const nodes: TreeNode[] = [];
    let cursor: TreeNode | undefined = tree.nodes[startNodeId];
    let successor: TreeNode | null = null;

    while (cursor) {
      const childNodes = visibleTreeChildren(cursor);
      if (isLinearChainBoundary(cursor, childNodes)) {
        successor = cursor;
        break;
      }

      nodes.push(cursor);
      if (childNodes.length === 0) break;
      cursor = childNodes[0];
    }

    return nodes.length >= 2 ? { nodes, successor } : null;
  }

  function linearChainKey(chain: LinearChain): string {
    return chain.nodes.map((node) => node.id).join(">");
  }

  function renderTreeEntry(nodeIdToRender: string, depth = 0) {
    const chain = collectLinearChain(nodeIdToRender);
    if (chain) return renderLinearChain(chain, depth);
    return renderTreeNode(nodeIdToRender, depth);
  }

  function renderTreeNode(
    nodeIdToRender: string,
    depth = 0,
    options: { renderChildren?: boolean; hideCaret?: boolean; key?: string } = {},
  ) {
    if (!tree) return null;
    const node = tree.nodes[nodeIdToRender];
    if (!node) return null;

    const childNodes =
      options.renderChildren === false ? [] : visibleTreeChildren(node);
    const isCurrent = node.id === currentId;
    const isOnPath = currentPathIds.has(node.id);
    const hasChildren = !options.hideCaret && childNodes.length > 0;
    const isCollapsed = !!collapsedNodes[node.id];

    return (
      <div key={options.key ?? node.id}>
        <div
          className="bw-tree-row-wrap"
          style={{ "--depth": `${Math.min(depth, 10) * 0.55}rem` } as CSSProperties}
        >
          {hasChildren ? (
            <button
              type="button"
              className="bw-tree-caret"
              aria-label={isCollapsed ? "Expand" : "Collapse"}
              aria-expanded={!isCollapsed}
              onClick={(event) => {
                event.stopPropagation();
                toggleCollapsed(node.id);
              }}
            >
              <svg
                viewBox="0 0 10 10"
                width="10"
                height="10"
                aria-hidden="true"
                style={{
                  transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)",
                  transition: "transform 120ms ease",
                }}
              >
                <path
                  d="M2 3.5 L5 6.5 L8 3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          ) : (
            <span className="bw-tree-caret bw-tree-caret-empty" aria-hidden="true" />
          )}
          <button
            type="button"
            className="bw-tree-star"
            data-on={node.starred}
            aria-label={node.starred ? "Unstar node" : "Star node"}
            aria-pressed={node.starred}
            title={node.starred ? "Unstar" : "Star"}
            disabled={streaming || saving}
            onClick={(event) => {
              event.stopPropagation();
              void onSetNodeStarred(node.id, !node.starred);
            }}
          >
            {node.starred ? "★" : "☆"}
          </button>
          <button
            type="button"
            onClick={() => void onSelectNode(node.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openTreeMenu(node.id, event.clientX, event.clientY);
            }}
            disabled={streaming || saving}
            className="bw-tree-row"
            data-current={isCurrent}
            data-path={isOnPath}
            data-hidden={node.hidden}
            data-starred={node.starred}
          >
            <span className="bw-tree-preview">{nodeLabel(node)}</span>
            <span className="bw-tree-meta">
              <span>{node.source.replace("_", " ")}</span>
              {hasChildren && <span>{childNodes.length} branch</span>}
            </span>
          </button>
        </div>
        {!isCollapsed &&
          childNodes.map((child) => renderTreeEntry(child.id, depth + 1))}
      </div>
    );
  }

  function renderLinearChain(chain: LinearChain, depth = 0) {
    const key = linearChainKey(chain);
    const expanded = !!expandedChains[key];
    const first = chain.nodes[0];
    const last = chain.nodes[chain.nodes.length - 1];
    const destination = chain.successor ?? last;
    const visibleCount = chain.nodes.length + (chain.successor ? 1 : 0);
    const chainOnPath =
      chain.nodes.some((node) => currentPathIds.has(node.id)) ||
      (chain.successor !== null && currentPathIds.has(chain.successor.id));
    const summary = `${visibleCount} nodes · "${previewText(first.text)}" -> "${previewText(destination.text)}"`;

    return (
      <div key={`chain-${key}`} className="bw-tree-chain">
        <div
          className="bw-tree-row-wrap"
          style={{ "--depth": `${Math.min(depth, 10) * 0.55}rem` } as CSSProperties}
        >
          <button
            type="button"
            className="bw-tree-caret"
            aria-label={expanded ? "Collapse linear run" : "Expand linear run"}
            aria-expanded={expanded}
            onClick={(event) => {
              event.stopPropagation();
              toggleChainExpanded(key);
            }}
          >
            <svg
              viewBox="0 0 10 10"
              width="10"
              height="10"
              aria-hidden="true"
              style={{
                transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
                transition: "transform 120ms ease",
              }}
            >
              <path
                d="M2 3.5 L5 6.5 L8 3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <span className="bw-tree-star bw-tree-star-spacer" aria-hidden="true" />
          <button
            type="button"
            className="bw-tree-chain-row"
            data-path={chainOnPath}
            onClick={() => {
              setExpandedChains((prev) => ({ ...prev, [key]: true }));
              void onSelectNode(destination.id);
            }}
            title={`Go to ${nodeLabel(destination)}`}
          >
            <span className="bw-tree-chain-summary">... {summary}</span>
          </button>
        </div>
        {expanded
          ? chain.nodes
              .map((node, index) =>
                renderTreeNode(node.id, depth + index, {
                  key: `chain-${key}-${node.id}`,
                  renderChildren: false,
                  hideCaret: true,
                }),
              )
              .concat(
                chain.successor
                  ? [renderTreeEntry(chain.successor.id, depth + chain.nodes.length)]
                  : [],
              )
          : chain.successor
            ? renderTreeEntry(chain.successor.id, depth)
            : null}
      </div>
    );
  }

  function viewportToCanvas(clientX: number, clientY: number) {
    const viewport = mapViewportRef.current;
    if (!viewport) return { x: 0, y: 0 };
    const rect = viewport.getBoundingClientRect();
    return {
      x: (clientX - rect.left - mapPan.x) / mapScale,
      y: (clientY - rect.top - mapPan.y) / mapScale,
    };
  }

  function onNodeMapPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button")) return;

    if (event.shiftKey) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const canvasPoint = viewportToCanvas(event.clientX, event.clientY);
      const next: NodeMapMarquee = {
        pointerId: event.pointerId,
        startCanvas: canvasPoint,
        currentCanvas: canvasPoint,
        baseSelection: mapSelectionIds.filter((id) => tree?.nodes[id]),
      };
      mapMarqueeRef.current = next;
      setMapMarquee(next);
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    mapDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: mapPan.x,
      panY: mapPan.y,
      moved: false,
    };
    setMapDragging(true);
  }

  function onNodeMapPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const liveMarquee = mapMarqueeRef.current;
    if (liveMarquee && liveMarquee.pointerId === event.pointerId) {
      const canvasPoint = viewportToCanvas(event.clientX, event.clientY);
      const next = { ...liveMarquee, currentCanvas: canvasPoint };
      mapMarqueeRef.current = next;
      setMapMarquee(next);
      return;
    }

    const drag = mapDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !nodeMapLayout) return;
    const viewport = mapViewportRef.current;
    if (!viewport) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.hypot(dx, dy) > 4) {
      drag.moved = true;
    }
    setMapPan(
      clampNodeMapPan(
        {
          x: drag.panX + dx,
          y: drag.panY + dy,
        },
        nodeMapLayout,
        { width: viewport.clientWidth, height: viewport.clientHeight },
        mapScale,
      ),
    );
  }

  function finishNodeMapDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const liveMarquee = mapMarqueeRef.current;
    if (liveMarquee && liveMarquee.pointerId === event.pointerId) {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const intersected = nodesInMarquee(liveMarquee);
      if (intersected.length > 0 || marqueeMoved(liveMarquee)) {
        mapSuppressClickRef.current = true;
        window.setTimeout(() => {
          mapSuppressClickRef.current = false;
        }, 0);
      }
      const merged = [...liveMarquee.baseSelection];
      const seen = new Set(merged);
      for (const id of intersected) {
        if (!seen.has(id)) {
          merged.push(id);
          seen.add(id);
        }
      }
      if (merged.length > 0) {
        setMapSelectionIds(merged);
        if (!seen.has(mapSelectedId ?? "")) {
          setMapSelectedId(merged[merged.length - 1]);
        }
      }
      mapMarqueeRef.current = null;
      setMapMarquee(null);
      return;
    }

    const drag = mapDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.moved) {
      mapSuppressClickRef.current = true;
      window.setTimeout(() => {
        mapSuppressClickRef.current = false;
      }, 0);
    }
    mapDragRef.current = null;
    setMapDragging(false);
  }

  function marqueeRect(marquee: NodeMapMarquee) {
    const x = Math.min(marquee.startCanvas.x, marquee.currentCanvas.x);
    const y = Math.min(marquee.startCanvas.y, marquee.currentCanvas.y);
    const width = Math.abs(marquee.startCanvas.x - marquee.currentCanvas.x);
    const height = Math.abs(marquee.startCanvas.y - marquee.currentCanvas.y);
    return { x, y, width, height };
  }

  function marqueeMoved(marquee: NodeMapMarquee) {
    const rect = marqueeRect(marquee);
    return rect.width > 2 || rect.height > 2;
  }

  function nodesInMarquee(marquee: NodeMapMarquee): string[] {
    if (!nodeMapLayout || !marqueeMoved(marquee)) return [];
    const rect = marqueeRect(marquee);
    const hit: string[] = [];
    for (const item of nodeMapLayout.nodes) {
      if (
        rect.x < item.x + item.width &&
        rect.x + rect.width > item.x &&
        rect.y < item.y + item.height &&
        rect.y + rect.height > item.y
      ) {
        hit.push(item.node.id);
      }
    }
    return hit;
  }

  function zoomNodeMap(factor: number, anchor?: { x: number; y: number }) {
    if (!nodeMapLayout) return;
    const viewport = mapViewportRef.current;
    if (!viewport) return;

    const viewportAnchor = anchor ?? {
      x: viewport.clientWidth / 2,
      y: viewport.clientHeight / 2,
    };
    const nextScale = clampNodeMapScale(mapScale * factor);
    if (nextScale === mapScale) return;

    const canvasX = (viewportAnchor.x - mapPan.x) / mapScale;
    const canvasY = (viewportAnchor.y - mapPan.y) / mapScale;
    const nextPan = clampNodeMapPan(
      {
        x: viewportAnchor.x - canvasX * nextScale,
        y: viewportAnchor.y - canvasY * nextScale,
      },
      nodeMapLayout,
      { width: viewport.clientWidth, height: viewport.clientHeight },
      nextScale,
    );

    setMapScale(nextScale);
    setMapPan(nextPan);
  }

  function onNodeMapWheel(event: ReactWheelEvent<HTMLDivElement>) {
    event.preventDefault();
    const viewport = mapViewportRef.current;
    if (!viewport) return;

    const rect = viewport.getBoundingClientRect();
    const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
    zoomNodeMap(factor, {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  }

  function showMapTooltip(text: string, event: ReactMouseEvent<Element>) {
    const x = Math.min(window.innerWidth - 260, event.clientX + 14);
    const y = Math.min(window.innerHeight - 72, event.clientY + 14);
    setMapTooltip({
      text,
      x: Math.max(8, x),
      y: Math.max(8, y),
    });
  }

  function moveMapTooltip(event: ReactMouseEvent<Element>) {
    setMapTooltip((current) => {
      if (!current) return null;
      const x = Math.min(window.innerWidth - 260, event.clientX + 14);
      const y = Math.min(window.innerHeight - 72, event.clientY + 14);
      return {
        ...current,
        x: Math.max(8, x),
        y: Math.max(8, y),
      };
    });
  }

  function hideMapTooltip() {
    setMapTooltip(null);
  }

  async function onSelectMapNode(
    nodeIdToSelect: string,
    options: { locate?: boolean; extend?: boolean } = {},
  ) {
    setMapSelectedId(nodeIdToSelect);
    setMapSelectionIds((current) => {
      if (!options.extend) return [nodeIdToSelect];
      const validCurrent = current.filter((id) => tree?.nodes[id]);
      if (validCurrent.includes(nodeIdToSelect)) return validCurrent;
      return [...validCurrent, nodeIdToSelect];
    });
    if (options.locate) {
      setMapLocateRequest((value) => value + 1);
    }
  }

  function onNodeMapMinimapPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (!nodeMapLayout) return;
    event.preventDefault();
    event.stopPropagation();

    const viewport = mapViewportRef.current;
    if (!viewport) return;

    const minimapScale = Math.min(
      NODE_MAP_MINIMAP_MAX_WIDTH / nodeMapLayout.width,
      NODE_MAP_MINIMAP_MAX_HEIGHT / nodeMapLayout.height,
    );
    const rect = event.currentTarget.getBoundingClientRect();
    const canvasX = (event.clientX - rect.left) / minimapScale;
    const canvasY = (event.clientY - rect.top) / minimapScale;

    setMapPan(
      clampNodeMapPan(
        {
          x: Math.round(viewport.clientWidth / 2 - canvasX * mapScale),
          y: Math.round(viewport.clientHeight / 2 - canvasY * mapScale),
        },
        nodeMapLayout,
        { width: viewport.clientWidth, height: viewport.clientHeight },
        mapScale,
      ),
    );
  }

  function renderNodeMap() {
    if (!tree || !currentId || !currentNode || !nodeMapLayout) return null;

    const validMapSelectionIds = mapSelectionIds.filter((id) => tree.nodes[id]);
    const resolvedSelectionIds =
      validMapSelectionIds.length > 0 ? validMapSelectionIds : [currentId];
    const marqueePreviewIds = mapMarquee ? nodesInMarquee(mapMarquee) : [];
    const previewSelectionIds = mapMarquee
      ? Array.from(new Set([...mapMarquee.baseSelection, ...marqueePreviewIds]))
      : resolvedSelectionIds;
    const selectionSet = new Set(previewSelectionIds);
    const multiSelectionEligibleIds = validMapSelectionIds.filter(
      (id) => tree.nodes[id]?.parentId !== null,
    );
    const multiSelectionDeleteIds = multiSelectionEligibleIds;
    const multiSelectionHideIds = multiSelectionEligibleIds.filter((id) => {
      const node = tree.nodes[id];
      return node && (node.hidden || id !== currentId);
    });
    const canMultiDelete =
      validMapSelectionIds.length >= 2 &&
      multiSelectionDeleteIds.length === validMapSelectionIds.length &&
      !(saving || streaming);
    const canMultiHide =
      validMapSelectionIds.length >= 2 &&
      multiSelectionHideIds.length === validMapSelectionIds.length &&
      !(saving || streaming);
    const selectedNode =
      mapSelectedId && tree.nodes[mapSelectedId]
        ? tree.nodes[mapSelectedId]
        : currentNode;

    const childNodes = childrenOf(tree, selectedNode.id);
    const parentNode = selectedNode.parentId ? tree.nodes[selectedNode.parentId] : null;
    const parentChildCount = parentNode ? childrenOf(tree, parentNode.id).length : 0;
    const actionDisabled = saving || streaming;
    const canDelete = selectedNode.parentId !== null && !actionDisabled;
    const canHide =
      selectedNode.parentId !== null &&
      (selectedNode.hidden || selectedNode.id !== currentId) &&
      !actionDisabled;
    const canMergeUp =
      selectedNode.parentId !== null &&
      parentNode !== null &&
      parentNode.parentId !== null &&
      parentChildCount === 1 &&
      !actionDisabled;
    const canMergeDown =
      selectedNode.parentId !== null && childNodes.length === 1 && !actionDisabled;
    const mergeSelectionAnalysis = analyzeNodeMapMergeSelection(
      tree,
      resolvedSelectionIds,
    );
    const canMergeSelection = mergeSelectionAnalysis.ok && !actionDisabled;
    const mergeSelectionHint = mergeSelectionAnalysis.ok
      ? "Merge selected nodes"
      : mergeSelectionAnalysis.reason;
    const starredNodes = Object.values(tree.nodes)
      .filter((node) => node.starred)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const mapScaleLabel = `${Math.round(mapScale * 100)}%`;
    const minimapScale = Math.min(
      NODE_MAP_MINIMAP_MAX_WIDTH / nodeMapLayout.width,
      NODE_MAP_MINIMAP_MAX_HEIGHT / nodeMapLayout.height,
    );
    const minimapWidth = Math.max(1, Math.round(nodeMapLayout.width * minimapScale));
    const minimapHeight = Math.max(1, Math.round(nodeMapLayout.height * minimapScale));
    const liveViewportWidth =
      mapViewportSize.width || mapViewportRef.current?.clientWidth || 1;
    const liveViewportHeight =
      mapViewportSize.height || mapViewportRef.current?.clientHeight || 1;
    const viewportRect = {
      x: clampNumber((-mapPan.x / mapScale) * minimapScale, 0, minimapWidth),
      y: clampNumber((-mapPan.y / mapScale) * minimapScale, 0, minimapHeight),
      width: clampNumber(
        (liveViewportWidth / mapScale) * minimapScale,
        1,
        minimapWidth,
      ),
      height: clampNumber(
        (liveViewportHeight / mapScale) * minimapScale,
        1,
        minimapHeight,
      ),
    };

    return (
      <section className="bw-node-map-shell" aria-label="Node map">
        <div className="bw-node-map-head">
          <div>
            <div className="bw-kicker">Node Map</div>
            <div className="bw-node-map-summary">
              {nodeMapLayout.nodes.length.toLocaleString()} of{" "}
              {Object.keys(tree.nodes).length.toLocaleString()} nodes shown ·{" "}
              {mapScaleLabel} · drag to pan, shift-drag to box-select
            </div>
          </div>
          <div className="bw-node-map-controls" aria-label="Map view controls">
            <button
              type="button"
              className="bw-button"
              title="Fit the whole tree (Cmd+0)"
              onMouseEnter={(event) =>
                showMapTooltip("Fit the entire node tree in the map.", event)
              }
              onMouseMove={moveMapTooltip}
              onMouseLeave={hideMapTooltip}
              onClick={() => setMapFitRequest((value) => value + 1)}
            >
              Fit all
            </button>
            <button
              type="button"
              className="bw-button bw-node-map-zoom-button"
              title="Zoom out (Cmd+-)"
              onMouseEnter={(event) => showMapTooltip("Zoom out.", event)}
              onMouseMove={moveMapTooltip}
              onMouseLeave={hideMapTooltip}
              onClick={() => zoomNodeMap(1 / 1.12)}
              aria-label="Zoom out"
            >
              -
            </button>
            <button
              type="button"
              className="bw-button bw-node-map-zoom-button"
              title="Zoom in (Cmd++)"
              onMouseEnter={(event) => showMapTooltip("Zoom in.", event)}
              onMouseMove={moveMapTooltip}
              onMouseLeave={hideMapTooltip}
              onClick={() => zoomNodeMap(1.12)}
              aria-label="Zoom in"
            >
              +
            </button>
            <button
              type="button"
              className="bw-button"
              title="Center the selected node"
              onMouseEnter={(event) =>
                showMapTooltip("Center the selected node in the map.", event)
              }
              onMouseMove={moveMapTooltip}
              onMouseLeave={hideMapTooltip}
              onClick={() => setMapLocateRequest((value) => value + 1)}
            >
              Locate selected
            </button>
            <label className="bw-node-map-toggle">
              <input
                type="checkbox"
                checked={mapShowHidden}
                onChange={(event) => {
                  setMapShowHidden(event.target.checked);
                  setMapFitRequest((value) => value + 1);
                }}
              />
              Show hidden
            </label>
          </div>
        </div>
        <div className="bw-node-map-body">
          <div
            ref={mapViewportRef}
            className="bw-node-map-viewport"
            data-dragging={mapDragging}
            onPointerDown={onNodeMapPointerDown}
            onPointerMove={onNodeMapPointerMove}
            onPointerUp={finishNodeMapDrag}
            onPointerCancel={finishNodeMapDrag}
            onWheel={onNodeMapWheel}
          >
            <div
              className="bw-node-map-canvas"
              style={{
                width: nodeMapLayout.width,
                height: nodeMapLayout.height,
                transform: `translate(${mapPan.x}px, ${mapPan.y}px) scale(${mapScale})`,
              }}
            >
              <svg
                className="bw-node-map-edges"
                viewBox={`0 0 ${nodeMapLayout.width} ${nodeMapLayout.height}`}
                aria-hidden="true"
              >
                {nodeMapLayout.edges.map((edge) => {
                  const parent = tree.nodes[edge.parentId];
                  const child = tree.nodes[edge.childId];
                  const active =
                    currentPathIds.has(edge.parentId) &&
                    currentPathIds.has(edge.childId);
                  const midY =
                    edge.fromY + Math.max(42, (edge.toY - edge.fromY) * 0.48);
                  return (
                    <path
                      key={`${edge.parentId}-${edge.childId}`}
                      className="bw-node-map-edge"
                      data-path={active}
                      data-hidden={child?.hidden ?? false}
                      d={`M ${edge.fromX} ${edge.fromY} C ${edge.fromX} ${midY}, ${edge.toX} ${midY}, ${edge.toX} ${edge.toY}`}
                      onMouseEnter={(event) =>
                        showMapTooltip(
                          `${parent ? nodeLabel(parent) : "missing parent"} -> ${child ? nodeLabel(child) : "missing child"}`,
                          event,
                        )
                      }
                      onMouseMove={moveMapTooltip}
                      onMouseLeave={hideMapTooltip}
                    />
                  );
                })}
              </svg>
              {nodeMapLayout.nodes.map((item) => {
                const node = item.node;
                const isCurrent = node.id === currentId;
                const isSelected = selectionSet.has(node.id);
                const isPrimarySelected = node.id === selectedNode.id;
                const isOnPath = currentPathIds.has(node.id);
                const nodeChildren = childrenOf(tree, node.id);
                return (
                  <button
                    key={node.id}
                    type="button"
                    className="bw-node-map-node"
                    data-current={isCurrent}
                    data-selected={isSelected}
                    data-primary={isPrimarySelected}
                    data-path={isOnPath}
                    data-hidden={node.hidden}
                    data-starred={node.starred}
                    style={{
                      left: item.x,
                      top: item.y,
                      width: item.width,
                      height: item.height,
                    }}
                    onClick={(event) => {
                      if (mapSuppressClickRef.current) return;
                      if (event.detail >= 2) {
                        event.preventDefault();
                        event.stopPropagation();
                        setWorkspaceMode("compose");
                        void onSelectNode(node.id);
                        return;
                      }
                      void onSelectMapNode(node.id, { extend: event.shiftKey });
                    }}
                    onDoubleClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setWorkspaceMode("compose");
                      void onSelectNode(node.id);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openTreeMenu(node.id, event.clientX, event.clientY);
                    }}
                    onMouseEnter={(event) =>
                      showMapTooltip(
                        `${nodeLabel(node)} · click to select, shift-click to add, double-click to open`,
                        event,
                      )
                    }
                    onMouseMove={moveMapTooltip}
                    onMouseLeave={hideMapTooltip}
                    disabled={actionDisabled}
                    title={`Select ${nodeLabel(node)}. Double-click to open in Compose.`}
                  >
                    <span className="bw-node-map-node-title">
                      {node.starred && <span aria-hidden="true">★</span>}
                      {nodeLabel(node)}
                    </span>
                    <span className="bw-node-map-node-meta">
                      {node.source.replace("_", " ")}
                      {nodeChildren.length > 0
                        ? ` · ${nodeChildren.length} child${
                            nodeChildren.length === 1 ? "" : "ren"
                          }`
                        : ""}
                      {node.hidden ? " · hidden" : ""}
                    </span>
                  </button>
                );
              })}
              {mapMarquee && (() => {
                const rect = marqueeRect(mapMarquee);
                return (
                  <div
                    className="bw-node-map-marquee"
                    style={{
                      left: rect.x,
                      top: rect.y,
                      width: rect.width,
                      height: rect.height,
                    }}
                    aria-hidden="true"
                  />
                );
              })()}
            </div>
            {mapTooltip && (
              <div
                className="bw-node-map-tooltip"
                style={{ left: mapTooltip.x, top: mapTooltip.y }}
                role="tooltip"
              >
                {mapTooltip.text}
              </div>
            )}
          </div>
          <aside className="bw-node-map-inspector" aria-label="Selected node">
            <div className="bw-node-map-inspector-head">
              <div className="bw-kicker">Selected</div>
              <div className="bw-node-map-current">{nodeLabel(selectedNode)}</div>
              <div className="bw-node-map-current-meta">
                {selectedNode.source.replace("_", " ")} · {childNodes.length} child
                {childNodes.length === 1 ? "" : "ren"}
                {selectedNode.hidden ? " · hidden" : ""}
                {resolvedSelectionIds.length > 1
                  ? ` · ${resolvedSelectionIds.length} selected`
                  : ""}
              </div>
            </div>
            <div className="bw-node-map-starred">
              <div className="bw-node-map-section-title">
                <span>Starred</span>
                <span>{starredNodes.length}</span>
              </div>
              {starredNodes.length > 0 ? (
                <div className="bw-node-map-starred-list">
                  {starredNodes.map((node) => (
                    <button
                      key={node.id}
                      type="button"
                      className="bw-node-map-starred-item"
                      data-current={node.id === selectedNode.id}
                      data-hidden={node.hidden}
                      onClick={() => void onSelectMapNode(node.id, { locate: true })}
                      onMouseEnter={(event) =>
                        showMapTooltip(`Jump to ${nodeLabel(node)}.`, event)
                      }
                      onMouseMove={moveMapTooltip}
                      onMouseLeave={hideMapTooltip}
                      disabled={actionDisabled || node.id === selectedNode.id}
                      title={`Jump to ${nodeLabel(node)}`}
                    >
                      <span>{nodeLabel(node)}</span>
                      {node.hidden && <small>hidden</small>}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="bw-node-map-empty-starred">
                  Star nodes to make them available here.
                </div>
              )}
            </div>
            <div className="bw-node-map-actions">
              <button
                type="button"
                className="bw-button"
                onClick={() =>
                  void onSetNodeStarred(selectedNode.id, !selectedNode.starred)
                }
                onMouseEnter={(event) =>
                  showMapTooltip(
                    selectedNode.starred
                      ? "Remove this node from the starred list."
                      : "Add this node to the starred list.",
                    event,
                  )
                }
                onMouseMove={moveMapTooltip}
                onMouseLeave={hideMapTooltip}
                disabled={actionDisabled}
              >
                {selectedNode.starred ? "Unstar" : "Star"}
              </button>
              <button
                type="button"
                className="bw-button"
                onClick={() =>
                  void onSetNodeHidden(selectedNode.id, !selectedNode.hidden)
                }
                onMouseEnter={(event) =>
                  showMapTooltip(
                    selectedNode.hidden
                      ? "Show this node in normal tree views."
                      : "Hide this node from normal tree views.",
                    event,
                  )
                }
                onMouseMove={moveMapTooltip}
                onMouseLeave={hideMapTooltip}
                disabled={!canHide}
                title={
                  selectedNode.id === currentId && !selectedNode.hidden
                    ? "Select another node before hiding this active node."
                    : selectedNode.parentId === null
                      ? "Root cannot be hidden."
                      : selectedNode.hidden
                        ? "Show this node."
                        : "Hide this node."
                }
              >
                {selectedNode.hidden ? "Unhide" : "Hide"}
              </button>
              <button
                type="button"
                className="bw-button"
                onClick={() => void onMergeNodeIntoParent(selectedNode.id)}
                onMouseEnter={(event) =>
                  showMapTooltip("Merge the selected node into its parent.", event)
                }
                onMouseMove={moveMapTooltip}
                onMouseLeave={hideMapTooltip}
                disabled={!canMergeUp}
                title={
                  canMergeUp
                    ? "Merge this node into its parent"
                    : "Available when the parent is not root and has exactly one child"
                }
              >
                Merge up
              </button>
              <button
                type="button"
                className="bw-button"
                onClick={() => void onMergeNodeWithOnlyChild(selectedNode.id)}
                onMouseEnter={(event) =>
                  showMapTooltip("Merge the selected node with its only child.", event)
                }
                onMouseMove={moveMapTooltip}
                onMouseLeave={hideMapTooltip}
                disabled={!canMergeDown}
                title={
                  canMergeDown
                    ? "Merge this node with its only child"
                    : "Available when this node has exactly one child"
                }
              >
                Merge down
              </button>
              <button
                type="button"
                className="bw-button bw-button-danger"
                onClick={() => void onDeleteMapNode(selectedNode.id)}
                onMouseEnter={(event) =>
                  showMapTooltip("Delete the selected node and its descendants.", event)
                }
                onMouseMove={moveMapTooltip}
                onMouseLeave={hideMapTooltip}
                disabled={!canDelete}
                title={
                  canDelete
                    ? "Delete this node and its descendants"
                    : "Root cannot be deleted"
                }
              >
                Delete
              </button>
              <button
                type="button"
                className="bw-button bw-node-map-action-wide"
                onClick={() => void onMergeMapSelection(resolvedSelectionIds)}
                onMouseEnter={(event) =>
                  showMapTooltip(
                    canMergeSelection
                      ? "Merge the shift-selected linear run into one node."
                      : mergeSelectionHint,
                    event,
                  )
                }
                onMouseMove={moveMapTooltip}
                onMouseLeave={hideMapTooltip}
                disabled={!canMergeSelection}
                title={canMergeSelection ? "Merge selected nodes" : mergeSelectionHint}
              >
                Merge selection
              </button>
              <button
                type="button"
                className="bw-button bw-node-map-action-wide"
                onClick={() => void onHideMapSelection(multiSelectionHideIds)}
                onMouseEnter={(event) =>
                  showMapTooltip(
                    canMultiHide
                      ? "Hide every node in the current selection."
                      : "Select two or more non-root, non-active nodes to hide together.",
                    event,
                  )
                }
                onMouseMove={moveMapTooltip}
                onMouseLeave={hideMapTooltip}
                disabled={!canMultiHide}
                title={
                  canMultiHide
                    ? "Hide every node in the selection"
                    : "Select two or more non-root, non-active nodes"
                }
              >
                Hide selection
              </button>
              <button
                type="button"
                className="bw-button bw-node-map-action-wide bw-button-danger"
                onClick={() => void onDeleteMapSelection(multiSelectionDeleteIds)}
                onMouseEnter={(event) =>
                  showMapTooltip(
                    canMultiDelete
                      ? "Delete every node in the current selection (and their descendants)."
                      : "Select two or more non-root nodes to delete together.",
                    event,
                  )
                }
                onMouseMove={moveMapTooltip}
                onMouseLeave={hideMapTooltip}
                disabled={!canMultiDelete}
                title={
                  canMultiDelete
                    ? "Delete every node in the selection"
                    : "Select two or more non-root nodes"
                }
              >
                Delete selection
              </button>
            </div>
            <div className="bw-node-map-merge-note">
              Shift-click a node to add it to the selection, or shift-drag a box
              across the canvas to select everything inside it. Merge is blocked
              whenever the upstream node has more than one child.
            </div>
            <div className="bw-node-map-minimap" aria-label="Node map minimap">
              <div className="bw-node-map-section-title">
                <span>Minimap</span>
              </div>
              <svg
                width={minimapWidth}
                height={minimapHeight}
                viewBox={`0 0 ${minimapWidth} ${minimapHeight}`}
                onPointerDown={onNodeMapMinimapPointerDown}
                onMouseEnter={(event) =>
                  showMapTooltip("Minimap. Click to jump the viewport.", event)
                }
                onMouseMove={moveMapTooltip}
                onMouseLeave={hideMapTooltip}
              >
                {nodeMapLayout.edges.map((edge) => (
                  <line
                    key={`${edge.parentId}-${edge.childId}-mini`}
                    x1={edge.fromX * minimapScale}
                    y1={edge.fromY * minimapScale}
                    x2={edge.toX * minimapScale}
                    y2={edge.toY * minimapScale}
                  />
                ))}
                {nodeMapLayout.nodes.map((item) => (
                  <rect
                    key={`${item.node.id}-mini`}
                    x={item.x * minimapScale}
                    y={item.y * minimapScale}
                    width={Math.max(2, item.width * minimapScale)}
                    height={Math.max(2, item.height * minimapScale)}
                    data-current={item.node.id === currentId}
                    data-selected={selectionSet.has(item.node.id)}
                  />
                ))}
                <rect
                  className="bw-node-map-minimap-view"
                  x={viewportRect.x}
                  y={viewportRect.y}
                  width={viewportRect.width}
                  height={viewportRect.height}
                />
              </svg>
            </div>
          </aside>
        </div>
      </section>
    );
  }

  function renderChatCandidateCards() {
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

  function renderChatSurface() {
    return (
      <div className="bw-chat-scroll">
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
                <textarea
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
                  {turn.role === "user" || turn.role === "assistant" ? (
                    <textarea
                      className="bw-chat-turn-editor"
                      value={chatTurnDrafts[turn.nodes[0]?.id ?? ""] ?? turn.text}
                      onChange={(event) => {
                        const key = turn.nodes[0]?.id;
                        if (!key) return;
                        setChatTurnDrafts((current) => ({
                          ...current,
                          [key]: event.target.value,
                        }));
                      }}
                      onBlur={(event) => void onSaveChatTurn(turn, event.target.value)}
                      onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                          event.preventDefault();
                          event.currentTarget.blur();
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          const key = turn.nodes[0]?.id;
                          if (key) {
                            setChatTurnDrafts((current) => {
                              const next = { ...current };
                              delete next[key];
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
                  {isActiveAssistant && renderChatCandidateCards()}
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
              <section
                className="bw-chat-turn"
                data-role="assistant"
                data-active="true"
              >
                <div className="bw-chat-turn-head">
                  <span>ASSISTANT</span>
                  <span>in progress</span>
                </div>
                {renderChatCandidateCards()}
              </section>
            )}

          {chatCanComposeUser && (
            <section className="bw-chat-turn bw-chat-input" data-role="user">
              <div className="bw-chat-turn-head">
                <span>YOU</span>
              </div>
              <textarea
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
        <div
          className="bw-modal-backdrop"
          role="dialog"
          aria-label="Model management"
          onMouseDown={() => setModelPanelOpen(false)}
        >
          <section
            className="bw-modal"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="bw-modal-head">
              <div>
                <div className="bw-kicker">TabbyAPI</div>
                <div className="mt-1 font-serif text-xl">
                  {formatModelLabel(currentTabbyModel)}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void onRefreshModels()}
                  disabled={loadingModels || modelBusy}
                  className="bw-button"
                >
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={() => void onUnloadModel()}
                  disabled={!currentTabbyModel || modelBusy || streaming}
                  className="bw-button"
                >
                  Unload
                </button>
                <button
                  type="button"
                  onClick={() => setModelPanelOpen(false)}
                  className="bw-button bw-button-quiet"
                >
                  Close
                </button>
              </div>
            </div>
            <div className="bw-modal-body">
              <div className="bw-form-grid two">
                <section className="bw-panel">
                  <div className="bw-kicker">Load local model</div>
                  <div className="mt-3 grid gap-2">
                    <select
                      value={selectedModelName}
                      onChange={(event) => setSelectedModelName(event.target.value)}
                      disabled={loadingModels || modelBusy}
                      className="bw-select w-full"
                    >
                      {availableModels.length === 0 && (
                        <option value="">No local models found</option>
                      )}
                      {availableModels.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.id}
                        </option>
                      ))}
                    </select>
                    <div className="flex flex-wrap items-end gap-2">
                      <label className="flex flex-col gap-1 text-[11px] text-[color:var(--ink-muted)]">
                        Context length
                        <input
                          type="text"
                          inputMode="numeric"
                          value={loadMaxSeqLen ? loadMaxSeqLen.toLocaleString() : ""}
                          onChange={(event) => {
                            const digits = event.target.value.replace(/[^\d]/g, "");
                            setLoadMaxSeqLen(digits ? Number(digits) : 0);
                          }}
                          disabled={modelBusy}
                          className="bw-input w-32"
                          title="max_seq_len"
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-[11px] text-[color:var(--ink-muted)]">
                        Cache (K/V)
                        <select
                          value={loadCacheMode}
                          onChange={(event) => setLoadCacheMode(event.target.value)}
                          disabled={modelBusy}
                          className="bw-select w-28"
                          title="K/V cache quantization"
                        >
                          <option value="Q4">Q4</option>
                          <option value="Q6">Q6</option>
                          <option value="Q8">Q8</option>
                          <option value="FP16">FP16</option>
                        </select>
                      </label>
                      <label className="bw-hidden-toggle">
                        <input
                          type="checkbox"
                          checked={loadTensorParallel}
                          onChange={(event) =>
                            setLoadTensorParallel(event.target.checked)
                          }
                          disabled={modelBusy}
                        />
                        <span>Tensor parallel</span>
                      </label>
                      <button
                        type="button"
                        onClick={() => void onLoadModel()}
                        disabled={!selectedModelName || modelBusy || streaming}
                        className="bw-button bw-button-primary"
                      >
                        {modelBusy && modelLoadEvent
                          ? formatLoadEvent(modelLoadEvent)
                          : "Load"}
                      </button>
                    </div>
                    <div className="text-xs text-[color:var(--ink-muted)]">
                      {COMMON_CONTEXT_SIZES}
                    </div>
                    <div className="grid gap-2 border-t border-[color:var(--line)] pt-3">
                      <div className="bw-kicker">Advanced</div>
                      <div className="flex flex-wrap items-end gap-2">
                        <label className="flex flex-col gap-1 text-[11px] text-[color:var(--ink-muted)]">
                          TP backend
                          <select
                            value={loadTensorParallelBackend}
                            onChange={(event) =>
                              setLoadTensorParallelBackend(
                                event.target.value as "native" | "nccl",
                              )
                            }
                            disabled={modelBusy || !loadTensorParallel}
                            className="bw-select w-28"
                            title="tensor_parallel_backend"
                          >
                            <option value="native">native</option>
                            <option value="nccl">nccl</option>
                          </select>
                        </label>
                        <label className="flex min-w-52 flex-1 flex-col gap-1 text-[11px] text-[color:var(--ink-muted)]">
                          GPU split
                          <input
                            value={loadGpuSplit}
                            onChange={(event) => setLoadGpuSplit(event.target.value)}
                            disabled={modelBusy}
                            placeholder="20, 25"
                            className="bw-input w-full"
                            title="gpu_split in GB per GPU"
                          />
                        </label>
                      </div>
                    </div>
                  </div>
                </section>

                <form
                  onSubmit={(event) => void onDownloadModel(event)}
                  className="bw-panel"
                >
                  <div className="bw-kicker">Download from Hugging Face</div>
                  <div className="mt-3 grid gap-2">
                    <input
                      value={downloadRepoId}
                      onChange={(event) => setDownloadRepoId(event.target.value)}
                      disabled={modelBusy}
                      placeholder="repo_id"
                      className="bw-input w-full"
                    />
                    <div className="flex flex-wrap gap-2">
                      <input
                        value={downloadRevision}
                        onChange={(event) => setDownloadRevision(event.target.value)}
                        disabled={modelBusy}
                        placeholder="revision"
                        className="bw-input w-32"
                      />
                      <input
                        value={downloadFolder}
                        onChange={(event) => setDownloadFolder(event.target.value)}
                        disabled={modelBusy}
                        placeholder="folder"
                        className="bw-input min-w-36 flex-1"
                      />
                      <button
                        type="submit"
                        disabled={!downloadRepoId.trim() || modelBusy || streaming}
                        className="bw-button"
                      >
                        {modelBusy && !modelLoadEvent ? "Working" : "Download"}
                      </button>
                    </div>
                    <div className="text-xs text-[color:var(--ink-muted)]">
                      Keep the request open until Tabby finishes.
                    </div>
                  </div>
                </form>
              </div>
            </div>
          </section>
        </div>
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
          {(isChatProject || workspaceMode === "compose") && treeVisible ? (
            <aside className="bw-tree">
              <div className="bw-rail-head">
                <div>
                  <div className="bw-kicker">Tree</div>
                </div>
                <div className="bw-tree-toggles">
                  <label className="bw-hidden-toggle">
                    <input
                      type="checkbox"
                      checked={showHidden}
                      onChange={(event) => setShowHidden(event.target.checked)}
                    />
                    <span>Show hidden</span>
                  </label>
                  <label className="bw-hidden-toggle">
                    <input
                      type="checkbox"
                      checked={starredOnly}
                      onChange={(event) => setStarredOnly(event.target.checked)}
                    />
                    <span>Only starred paths</span>
                  </label>
                </div>
              </div>
              <div className="bw-tree-search">
                <input
                  type="search"
                  value={treeSearch}
                  onChange={(event) => setTreeSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setTreeSearch("");
                    }
                  }}
                  placeholder="Search node names..."
                  className="bw-tree-search-input"
                  aria-label="Search tree by node name"
                />
                {treeSearch && (
                  <button
                    type="button"
                    className="bw-tree-search-clear"
                    onClick={() => setTreeSearch("")}
                    aria-label="Clear search"
                    title="Clear"
                  >
                    ×
                  </button>
                )}
              </div>
              <div className="bw-tree-list">
                {treeFilterNote && (
                  <div className="bw-tree-filter-note">{treeFilterNote}</div>
                )}
                {renderTreeNode(tree.rootId)}
              </div>
              <div className="bw-tree-foot">
                {visibleTreeNodeCount().toLocaleString()} visible ·{" "}
                {Object.keys(tree.nodes).length.toLocaleString()} total
              </div>
            </aside>
          ) : isChatProject || workspaceMode === "compose" ? (
            <div className="bw-collapsed-rail bw-collapsed-rail-left">
              <button
                type="button"
                className="bw-edge-toggle bw-edge-toggle-tree bw-edge-toggle-collapsed"
                onClick={() => setTreeVisible(true)}
                aria-label="Show tree panel"
                title="Show tree"
              >
                ›
              </button>
            </div>
          ) : null}

          {(isChatProject || workspaceMode === "compose") && treeVisible && (
            <div
              className="bw-splitter bw-tree-splitter"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize tree column"
              onMouseDown={(event) =>
                startColumnDrag(event, setTreeWidth, treeWidth, 1, 180, 480)
              }
            >
              <button
                type="button"
                className="bw-edge-toggle bw-edge-toggle-tree"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => setTreeVisible(false)}
                aria-label="Hide tree panel"
                title="Hide tree"
              >
                ‹
              </button>
            </div>
          )}

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
                    setMapFitRequest((value) => value + 1);
                    if (dirtyBuffer) {
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
                branchPickerOpen &&
                branchViewMode === "grid" &&
                composeDisplayMode === "cards" && (
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
                        const hasText = candidate.text.length > 0;
                        const isStreaming = streaming && !candidate.done;
                        const kept = !!savedCandidateIds[index];
                        const picked = pickedCandidateIndex === index;
                        const centeredStart =
                          firstCenteredBranchIndex === index && centeredBranchStart
                            ? centeredBranchStart
                            : null;
                        return (
                          <section
                            key={index}
                            className="bw-branch-card"
                            data-empty={!hasText}
                            data-streaming={isStreaming}
                            data-picked={picked}
                            style={
                              centeredStart === null
                                ? undefined
                                : { gridColumn: `${centeredStart} / span 2` }
                            }
                          >
                            <div className="bw-branch-card-head">
                              <div className="bw-branch-card-title">
                                <span>Branch {index + 1}</span>
                                {picked && (
                                  <span className="bw-branch-used-badge">Used</span>
                                )}
                                {isStreaming && (
                                  <span
                                    className="bw-branch-pulse"
                                    aria-label="Streaming"
                                  />
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
                                disabled={!hasText || streaming || saving || kept}
                                className="bw-button"
                              >
                                {kept ? "Kept" : "Keep"}
                              </button>
                            </div>
                          </section>
                        );
                      })}
                    </div>
                  </section>
                )}

              {!isChatProject &&
                workspaceMode === "compose" &&
                candidateContext === "prose" &&
                branchPickerOpen &&
                branchViewMode === "grid" &&
                composeDisplayMode === "cards" && (
                  <div
                    className="bw-row-splitter"
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label="Resize branch comparison"
                    onMouseDown={startRowDrag}
                  />
                )}

              {!isChatProject &&
                workspaceMode === "compose" &&
                candidateContext === "prose" &&
                branchPickerOpen &&
                branchViewMode === "strip" && (
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
                          <div
                            key={index}
                            className="bw-branch-mini"
                            data-picked={picked}
                          >
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

              {isChatProject ? (
                renderChatSurface()
              ) : workspaceMode === "map" ? (
                renderNodeMap()
              ) : (
                <>
                  <div className="bw-manuscript-scroll">
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
                    <div
                      className="bw-inline-controls"
                      data-streaming={streaming && !visibleCandidate.done}
                    >
                      {candidates.length > 1 && (
                        <div className="bw-inline-cycler" aria-label="Cycle branches">
                          <button
                            type="button"
                            onClick={() => cycleVisibleCandidate(-1)}
                            aria-label="Previous branch"
                          >
                            ‹
                          </button>
                          <button
                            type="button"
                            onClick={() => cycleVisibleCandidate(1)}
                            aria-label="Next branch"
                          >
                            ›
                          </button>
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => onUseCandidate(visibleCandidateIndex)}
                        disabled={!visibleCandidate.text || streaming || saving}
                        className="bw-button bw-button-primary"
                      >
                        Use
                      </button>
                      <button
                        type="button"
                        onClick={() => void onKeepCandidate(visibleCandidateIndex)}
                        disabled={
                          !visibleCandidate.text ||
                          saving ||
                          !!savedCandidateIds[visibleCandidateIndex]
                        }
                        title={
                          savedCandidateIds[visibleCandidateIndex]
                            ? "Already kept"
                            : "Keep branch"
                        }
                        className="bw-button"
                      >
                        {savedCandidateIds[visibleCandidateIndex] ? "Kept" : "Keep"}
                      </button>
                      <button
                        type="button"
                        onClick={clearBranchPicker}
                        disabled={streaming || saving}
                        className="bw-button"
                      >
                        Clear
                      </button>
                      <span className="bw-inline-placement">
                        inserts at end of draft
                      </span>
                      <span className="bw-inline-meta">
                        Branch {visibleCandidateIndex + 1}
                        {candidates.length > 1 ? ` of ${candidates.length}` : ""}
                        {visibleCandidate.text
                          ? ` · ${approxTokenCount(visibleCandidate.text)} tok`
                          : ""}
                        {" · Tab accept · Ctrl+] / [ cycle · Esc clear"}
                        {streaming && !visibleCandidate.done && " · streaming"}
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>

            <footer className="bw-actionbar">
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
                      className="bw-select min-w-36"
                    >
                      <option value="">none</option>
                      {presets.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.name}
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
                      max={maxBranches}
                      value={branchCountText}
                      onChange={(event) => {
                        const next = event.target.value;
                        setBranchCountText(next);
                        setBranchLimitHint(false);
                        // Real-time validation: a non-empty, non-digit value
                        // (e.g. "abc") used to silently sit there until blur
                        // or Generate. Surface it immediately so the user
                        // doesn't think a bogus value was accepted. Empty
                        // strings stay error-free as a transient mid-edit
                        // state — the blur handler covers that case.
                        if (next.trim() === "" || /^\d+$/.test(next.trim())) {
                          setBranchCountError(null);
                        } else {
                          setBranchCountError(`Enter 1-${maxBranches} branches.`);
                        }
                      }}
                      onBlur={() => {
                        normalizeBranchCount();
                      }}
                      aria-invalid={branchCountError !== null}
                      disabled={streaming || saving}
                      className="bw-input w-16"
                      title={branchLimitMessage}
                    />
                    {(branchCountError || branchLimitHint) && (
                      <span
                        className="bw-field-note"
                        data-error={branchCountError !== null}
                      >
                        {branchCountError ?? branchLimitMessage}
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
                      value={maxTokensText}
                      onChange={(event) => {
                        setMaxTokensText(event.target.value);
                        setMaxTokensError(null);
                        setMaxTokensLimitHint(false);
                      }}
                      onBlur={() => {
                        normalizeMaxTokens();
                      }}
                      aria-invalid={maxTokensError !== null}
                      disabled={streaming || saving}
                      className="bw-input w-24"
                      title={
                        contextMax
                          ? `1-${contextMax.toLocaleString()} (loaded context)`
                          : undefined
                      }
                    />
                    {(maxTokensError || maxTokensLimitHint) && (
                      <span
                        className="bw-field-note"
                        data-error={maxTokensError !== null}
                      >
                        {maxTokensError ??
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
                </>
              ) : workspaceMode === "autocomplete" ? (
                <label className="bw-field">
                  Tokens per suggestion
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={tokensPerSuggestionText}
                    onChange={(event) => setTokensPerSuggestionText(event.target.value)}
                    onBlur={() => {
                      normalizeTokensPerSuggestion();
                    }}
                    disabled={saving}
                    className="bw-input w-16"
                  />
                </label>
              ) : null}
              <div className="flex-1" />
              <div className="bw-action-main">
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
                {project && (
                  <span className="bw-save-state" data-dirty={dirtyBuffer}>
                    {dirtyBuffer ? "Unsaved changes" : "Saved"}
                  </span>
                )}
                {isChatProject && streaming ? (
                  <button
                    type="button"
                    onClick={onCancel}
                    className="bw-button bw-button-primary"
                  >
                    Stop
                  </button>
                ) : isChatProject ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (chatHasPendingUserDraft) void onSubmitChatUser();
                      else void startChatAssistantGeneration();
                    }}
                    disabled={saving || !currentTabbyModel || !chatCanSubmitOrGenerate}
                    className="bw-button bw-button-primary"
                    title={
                      chatHasPendingUserDraft
                        ? "Send message and generate reply"
                        : "Generate assistant branches"
                    }
                  >
                    {chatHasPendingUserDraft ? "Send" : "Generate"}
                  </button>
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
