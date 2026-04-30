import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
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
  streamCompletion,
  streamModelLoad,
  unloadModel,
  updateProjectSettings,
  updatePreset,
  type ComposeDisplayMode,
  type ModelLoadEvent,
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
};

type BranchViewMode = "grid" | "strip";

type WorkspaceMode = "compose" | "autocomplete";

type UsedCandidateRange = {
  start: number;
  end: number;
};

type AutocompleteState =
  | { phase: "idle" }
  | { phase: "thinking" }
  | { phase: "showing"; suggestions: string[]; visibleIdx: number };

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected error";
}

function nodeId(): string {
  return crypto.randomUUID();
}

function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

function previewText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "root";
  return normalized.length > 88 ? `${normalized.slice(0, 88)}...` : normalized;
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
): TreeNode {
  return {
    id: nodeId(),
    parentId,
    text,
    name: null,
    source,
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

function nodeLabel(node: TreeNode): string {
  const name = node.name?.trim();
  if (name) return name;
  return previewText(node.text);
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
const DEFAULT_BRANCH_LIMIT = 8;
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
  return Math.max(1, Math.trunc(maxBatchSize));
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
  const [candidatePrompt, setCandidatePrompt] = useState<string | null>(null);
  const [candidateBaseId, setCandidateBaseId] = useState<string | null>(null);
  const [candidateModelId, setCandidateModelId] = useState<string | null>(null);
  const [candidateSamplerSnapshot, setCandidateSamplerSnapshot] =
    useState<SamplerBody | null>(null);
  const [savedCandidateIds, setSavedCandidateIds] = useState<
    Record<number, string>
  >({});
  const [branchCountText, setBranchCountText] = useState(
    String(DEFAULT_BRANCH_COUNT),
  );
  const [branchLimitHint, setBranchLimitHint] = useState(false);
  const [maxTokensText, setMaxTokensText] = useState(String(DEFAULT_MAX_TOKENS));
  const [tokensPerSuggestionText, setTokensPerSuggestionText] = useState(
    String(DEFAULT_TOKENS_PER_SUGGESTION),
  );
  const [streaming, setStreaming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingProject, setLoadingProject] = useState(true);
  const [currentTabbyModel, setCurrentTabbyModel] = useState<TabbyModel | null>(
    null,
  );
  const [availableModels, setAvailableModels] = useState<TabbyModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);
  const [modelPanelOpen, setModelPanelOpen] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelLoadEvent, setModelLoadEvent] = useState<ModelLoadEvent | null>(
    null,
  );
  const [selectedModelName, setSelectedModelName] = useState("");
  const [loadMaxSeqLen, setLoadMaxSeqLen] = useState(DEFAULT_LOAD_MAX_SEQ_LEN);
  const [loadCacheMode, setLoadCacheMode] = useState("Q6");
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
  const [collapsedNodes, setCollapsedNodes] = useState<Record<string, boolean>>(
    {},
  );
  const [branchViewMode, setBranchViewMode] =
    useState<BranchViewMode>("grid");
  const [visibleCandidateIndex, setVisibleCandidateIndex] = useState(0);
  const [composeDisplayMode, setComposeDisplayMode] =
    useState<ComposeDisplayMode>("cards");
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("compose");
  const [autocompleteState, setAutocompleteState] = useState<AutocompleteState>({
    phase: "idle",
  });
  const [autocompleteStatus, setAutocompleteStatus] = useState<string | null>(
    null,
  );
  const [pickedCandidateIndex, setPickedCandidateIndex] = useState<number | null>(
    null,
  );
  const [usedCandidateRange, setUsedCandidateRange] =
    useState<UsedCandidateRange | null>(null);
  const [branchPaneRatio, setBranchPaneRatio] = useState(
    SINGLE_ROW_BRANCH_PANE_RATIO,
  );
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [treeVisible, setTreeVisible] = useState(true);
  const [treeWidth, setTreeWidth] = useState(288);
  const abortRef = useRef<AbortController | null>(null);
  const autocompleteAbortRef = useRef<AbortController | null>(null);
  const editorRef = useRef<WorkbookEditorHandle | null>(null);
  const bufferSelectionRef = useRef<{ start: number; end: number } | null>(null);

  const branchPickerOpen = candidatePrompt !== null;
  const contextMax = modelContextMax(currentTabbyModel);
  const maxBranches = maxBranchesForModel(currentTabbyModel);
  const autocompleteSuggestion =
    autocompleteState.phase === "showing"
      ? autocompleteState.suggestions[autocompleteState.visibleIdx] ?? null
      : null;
  const contextPct =
    tokenCount !== null && contextMax ? tokenCount / contextMax : null;
  const contextWarn = contextPct !== null && contextPct >= 0.9;

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

  const clearBranchPicker = useCallback(() => {
    setCandidates([]);
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
    (
      presetsList: SamplerPreset[],
      nextActiveId: string | null,
    ) => {
      setActivePresetIdState(nextActiveId);
      const picked =
        nextActiveId === null
          ? null
          : presetsList.find((p) => p.id === nextActiveId) ?? null;
      setDraftBody(picked ? { ...picked.body } : neutralBody());
    },
    [],
  );

  const refreshModels = useCallback(async () => {
    setLoadingModels(true);
    try {
      const [current, models] = await Promise.all([
        currentModel(),
        listModels(),
      ]);
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
  }

  function saveProjectSettings(patch: ProjectSettingsPatch) {
    if (!project) return;
    void updateProjectSettings(patch).catch((err) => {
      setError(formatError(err));
    });
  }

  const loadProject = useCallback(
    async (info: ProjectInfo) => {
      const [nodes, settings] = await Promise.all([
        listNodes(),
        getProjectSettings(),
      ]);
      const loaded = loadedTreeFromModels(nodes);
      setProject(info);
      setTree(loaded.tree);
      setCurrentId(loaded.currentId);
      setBuffer(concatPathText(pathFromRoot(loaded.tree, loaded.currentId)));
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
      parsePositiveInt(
        tokensPerSuggestionText,
        DEFAULT_TOKENS_PER_SUGGESTION,
      ),
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

      const partials = Array.from(
        { length: AUTOCOMPLETE_POOL_TARGET },
        () => "",
      );
      const slotsByIndex = Array.from(
        { length: AUTOCOMPLETE_POOL_TARGET },
        () => -1,
      );

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
      if (streaming || saving) return null;

      setSaving(true);
      setError(null);
      try {
        const reshaped = reshape(tree, currentId, nextBuffer, {
          newId: nodeId,
          now: nowEpoch,
          source,
        });
        const batch = mutationBatchFromTrees(
          tree,
          reshaped.tree,
          reshaped.currentId,
        );

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
  }, [closeConfirmOpen, commitBuffer, modelPanelOpen, samplerOpen, treeMenu]);

  useEffect(() => {
    if (!treeMenu) return;
    function onPointerDown() {
      setTreeMenu(null);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [treeMenu]);

  useEffect(() => {
    if (branchCountText.trim() === "") return;
    const parsed = parsePositiveInt(branchCountText, DEFAULT_BRANCH_COUNT);
    const clamped = clampNumber(parsed, 1, maxBranches);
    if (clamped !== parsed) {
      setBranchCountText(String(clamped));
      setBranchLimitHint(true);
    }
    // Only normalize when the loaded model changes the allowed ceiling.
    // Normalizing on every keystroke would reintroduce the leading-zero bug.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxBranches]);

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

  // Default the project title to the chosen filename's stem. The user
  // can rename later; we never derive title from anything we recorded.
  function titleFromPath(path: string): string {
    const base = path.split("/").pop() ?? path;
    return base.replace(/\.bwbk$/i, "") || "Branching Workbook";
  }

  async function onCreateProject() {
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
      const info = await createProject(chosen, titleFromPath(chosen));
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
      await streamModelLoad(
        {
          model_name: trimmedModelName,
          max_seq_len: Math.max(
            256,
            Math.trunc(loadMaxSeqLen) || DEFAULT_LOAD_MAX_SEQ_LEN,
          ),
          cache_mode: loadCacheMode,
        },
        setModelLoadEvent,
      );
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

    const committed = await commitBuffer();
    if (!committed) return;

    const targetId = committed.tree.nodes[nodeIdToSelect]
      ? nodeIdToSelect
      : committed.currentId;
    const path = pathFromRoot(committed.tree, targetId);

    setSaving(true);
    setError(null);
    try {
      await mutateNodes({ main_path: path.map((node) => node.id) });
      setTree(committed.tree);
      setCurrentId(targetId);
      setBuffer(concatPathText(path));
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSaving(false);
    }
  }

  function normalizeBranchCount(): number {
    const parsed = parsePositiveInt(branchCountText, DEFAULT_BRANCH_COUNT);
    const clamped = clampNumber(parsed, 1, maxBranches);
    setBranchCountText(String(clamped));
    setBranchLimitHint(parsed > maxBranches);
    saveProjectSettings({ branch_count: clamped });
    return clamped;
  }

  function normalizeMaxTokens(): number {
    const normalized = Math.max(
      1,
      parsePositiveInt(maxTokensText, DEFAULT_MAX_TOKENS),
    );
    setMaxTokensText(String(normalized));
    saveProjectSettings({ max_tokens: normalized });
    return normalized;
  }

  function normalizeTokensPerSuggestion(): number {
    const normalized = clampNumber(
      parsePositiveInt(
        tokensPerSuggestionText,
        DEFAULT_TOKENS_PER_SUGGESTION,
      ),
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
    const resolvedMaxTokens = normalizeMaxTokens();
    const promptSnapshot = committed.buffer;
    // Resolve the sampler snapshot *now* so a user tweaking the drawer
    // mid-stream doesn't retroactively change what a persisted node says
    // produced it.
    const samplerSnapshot = mergePreset(draftBody);
    setCandidates(Array.from({ length: n }, () => ({ text: "", done: false })));
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
                      (_, index) => current[index] ?? { text: "", done: false },
                    );
              const existing = next[choice.index] ?? { text: "", done: false };
              next[choice.index] = {
                text: existing.text + choice.text,
                done: existing.done || choice.finish_reason !== null,
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
    bufferSelectionRef.current = selection;
  }

  function onUseCandidate(index: number) {
    const text = candidates[index]?.text ?? "";
    if (!text) {
      setError("Select a branch with text before using it.");
      return;
    }

    const canReplaceUsed =
      branchViewMode === "strip" &&
      pickedCandidateIndex !== null &&
      usedCandidateRange !== null;
    // Inline compose pins insertion to the end of the document. The ghost
    // preview is rendered at end-of-doc, and clicking "Use" while the
    // editor isn't focused would otherwise pull the cursor to a stale
    // selection — sometimes way above the visible region.
    const useEnd = composeDisplayMode === "inline" && !canReplaceUsed;
    const selection = bufferSelectionRef.current;
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

    setBuffer(nextBuffer);
    bufferSelectionRef.current = { start: nextCursor, end: nextCursor };
    setUsedCandidateRange({ start, end: nextCursor });
    setPickedCandidateIndex(index);
    setBranchViewMode("strip");
    window.requestAnimationFrame(() => {
      editorRef.current?.focus();
      editorRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  }

  async function onKeepCandidate(index: number) {
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

  const currentPath =
    tree && currentId ? pathFromRoot(tree, currentId) : [];
  const currentPathIds = new Set(currentPath.map((node) => node.id));
  const currentNode = tree && currentId ? tree.nodes[currentId] : null;

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
  const searchLineageIds = useMemo<Set<string> | null>(() => {
    if (!tree) return null;
    const query = treeSearch.trim().toLowerCase();
    if (query.length === 0) return null;
    const matchIds = Object.values(tree.nodes)
      .filter((node) => nodeLabel(node).toLowerCase().includes(query))
      .map((node) => node.id);
    if (matchIds.length === 0) return new Set<string>();

    const lineage = new Set<string>();
    for (const id of matchIds) {
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
    const stack = [...matchIds];
    while (stack.length > 0) {
      const id = stack.pop()!;
      for (const childId of childrenByParent[id] ?? []) {
        if (lineage.has(childId)) continue;
        lineage.add(childId);
        stack.push(childId);
      }
    }
    return lineage;
  }, [tree, treeSearch]);
  const visibleCandidate = candidates[visibleCandidateIndex] ?? null;
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
          if (
            workspaceMode === "autocomplete" &&
            autocompleteState.phase !== "idle"
          ) {
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
    workspaceMode === "autocomplete"
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

  async function onSetMainThread(nodeIdToPromote: string) {
    setTreeMenu(null);
    await onSelectNode(nodeIdToPromote);
  }

  function renderTreeNode(nodeIdToRender: string, depth = 0) {
    if (!tree) return null;
    const node = tree.nodes[nodeIdToRender];
    if (!node) return null;

    const childNodes = childrenOf(tree, node.id)
      .filter((child) => showHidden || !child.hidden)
      .filter(
        (child) =>
          !starredOnly ||
          starredLineageIds === null ||
          starredLineageIds.has(child.id),
      )
      .filter(
        (child) =>
          searchLineageIds === null || searchLineageIds.has(child.id),
      )
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const isCurrent = node.id === currentId;
    const isOnPath = currentPathIds.has(node.id);
    const hasChildren = childNodes.length > 0;
    const isCollapsed = !!collapsedNodes[node.id];

    return (
      <div key={node.id}>
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
                <path d="M2 3.5 L5 6.5 L8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
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
              setTreeMenu({
                nodeId: node.id,
                x: event.clientX,
                y: event.clientY,
              });
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
          childNodes.map((child) => renderTreeNode(child.id, depth + 1))}
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
          <span className="bw-dot" data-live={currentTabbyModel !== null} />
          <button
            type="button"
            className="bw-link-button"
            onClick={() => setModelPanelOpen(true)}
          >
            {loadingModels ? "checking model" : formatModelLabel(currentTabbyModel)}
          </button>
          {project && (
            <>
              <span className={contextWarn ? "text-[color:var(--warn)]" : ""}>
                <strong>
                  {tokenCount === null ? "unknown" : tokenCount.toLocaleString()}
                </strong>
                {" / "}
                {contextMax === null ? "unknown" : contextMax.toLocaleString()}
                {" tokens"}
              </span>
              <span className="bw-status-sep" aria-hidden="true">·</span>
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

      {error && <div className="bw-error">{error}</div>}

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
              The current buffer has edits that have not been saved into the
              workbook.
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
              tree.nodes[treeMenu.nodeId]?.parentId === null
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
                          type="number"
                          min={256}
                          step={256}
                          value={loadMaxSeqLen}
                          onChange={(event) => setLoadMaxSeqLen(Number(event.target.value))}
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
                  onClick={() => void onCreateProject()}
                  disabled={loadingProject}
                  className="bw-button bw-button-primary"
                >
                  New workbook…
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
          {workspaceMode === "compose" && treeVisible ? (
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
                      onChange={(event) =>
                        setStarredOnly(event.target.checked)
                      }
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
              <div className="bw-tree-list">{renderTreeNode(tree.rootId)}</div>
              <div className="bw-tree-foot">
                {Object.keys(tree.nodes).length.toLocaleString()} nodes
              </div>
            </aside>
          ) : workspaceMode === "compose" ? (
            <button
              type="button"
              className="bw-rail-handle bw-rail-handle-left"
              onClick={() => setTreeVisible(true)}
              aria-label="Show tree panel"
              title="Show tree"
            >
              Tree
            </button>
          ) : null}

          {workspaceMode === "compose" && treeVisible && (
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
            <nav className="bw-mode-tabs" aria-label="Writing mode">
              <button
                type="button"
                data-active={workspaceMode === "compose"}
                onClick={() => {
                  if (workspaceMode === "autocomplete") {
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
                    editorRef.current?.setSelectionRange(buffer.length, buffer.length);
                  });
                }}
                disabled={streaming}
              >
                Autocomplete
              </button>
            </nav>
            <div
              className="bw-editor-main"
              data-branch-view={
                workspaceMode === "compose" && branchPickerOpen
                  ? branchViewMode
                  : "none"
              }
            >
              {workspaceMode === "compose" &&
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
                          style={
                            centeredStart === null
                              ? undefined
                              : { gridColumn: `${centeredStart} / span 2` }
                          }
                        >
                          <div className="bw-branch-card-head">
                            <div className="bw-branch-card-title">
                              <span>Branch {index + 1}</span>
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
                              candidate.text
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
                              disabled={!hasText || streaming || saving}
                              className="bw-button bw-button-primary"
                            >
                              Use
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

              {workspaceMode === "compose" &&
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

              {workspaceMode === "compose" &&
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
                            onClick={() => setBranchViewMode("grid")}
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
                              onClick={() => void onKeepCandidate(index)}
                              disabled={!hasText || saving || kept}
                              title={kept ? "Already kept" : "Keep branch"}
                            >
                              {kept ? "Kept" : "Keep"}
                            </button>
                            <button
                              type="button"
                              onClick={() => onUseCandidate(index)}
                              disabled={!hasText || saving || picked}
                              title={picked ? "Already used" : "Use instead"}
                            >
                              Use instead
                            </button>
                            <button
                              type="button"
                              onClick={() => setBranchViewMode("grid")}
                              title="Expand branches"
                            >
                              Expand
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
                          currentNode.starred ? "Unstar this node" : "Star this node"
                        }
                        aria-pressed={currentNode.starred}
                        title={currentNode.starred ? "Unstar this node" : "Star this node"}
                        disabled={saving || streaming}
                        onClick={() =>
                          void onSetNodeStarred(currentNode.id, !currentNode.starred)
                        }
                      >
                        {currentNode.starred ? "★" : "☆"}
                      </button>
                    </div>
                  )}
                  <WorkbookEditor
                    ref={editorRef}
                    value={buffer}
                    onChange={(nextBuffer) => {
                      setBuffer(nextBuffer);
                      setUsedCandidateRange(null);
                    }}
                    onSelectionChange={(selection: EditorSelection) => {
                      bufferSelectionRef.current = selection;
                    }}
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
                  {workspaceMode === "compose" &&
                    composeDisplayMode === "inline" &&
                    branchPickerOpen &&
                    branchViewMode === "grid" &&
                    visibleCandidate && (
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
            </div>

            <footer className="bw-actionbar">
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
                <span title="Unsaved sampler changes" className="text-[color:var(--warn)]">
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
              {workspaceMode === "compose" ? (
                <>
                  <label className="bw-field">
                    Branches
                    <input
                      type="number"
                      min={1}
                      max={maxBranches}
                      value={branchCountText}
                      onChange={(event) => {
                        setBranchCountText(event.target.value);
                        setBranchLimitHint(false);
                      }}
                      onBlur={() => {
                        normalizeBranchCount();
                      }}
                      disabled={streaming || saving}
                      className="bw-input w-16"
                      title={`Max ${maxBranches} with this model`}
                    />
                    {branchLimitHint && (
                      <span className="bw-field-note">
                        max {maxBranches} with this model
                      </span>
                    )}
                  </label>
                  <label className="bw-field">
                    Max tokens
                    <input
                      type="number"
                      min={1}
                      value={maxTokensText}
                      onChange={(event) => setMaxTokensText(event.target.value)}
                      onBlur={() => {
                        normalizeMaxTokens();
                      }}
                      disabled={streaming || saving}
                      className="bw-input w-24"
                    />
                  </label>
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
                </>
              ) : (
                <label className="bw-field">
                  Tokens per suggestion
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={tokensPerSuggestionText}
                    onChange={(event) =>
                      setTokensPerSuggestionText(event.target.value)
                    }
                    onBlur={() => {
                      normalizeTokensPerSuggestion();
                    }}
                    disabled={saving}
                    className="bw-input w-16"
                  />
                </label>
              )}
              <div className="flex-1" />
              <div className="bw-action-main">
                <button
                  type="button"
                  onClick={() => void onSave()}
                  disabled={saving || streaming}
                  className="bw-button"
                >
                  {saving ? "Saving" : "Save"}
                </button>
                {workspaceMode === "compose" && streaming ? (
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
