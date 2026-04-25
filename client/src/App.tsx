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
  listModels,
  listNodes,
  listPresets,
  mutateNodes,
  openProject,
  setActivePreset,
  streamCompletion,
  streamModelLoad,
  unloadModel,
  updatePreset,
  type ModelLoadEvent,
  type ProjectInfo,
  type SamplerBody,
  type SamplerPreset,
  type TabbyModel,
} from "./api";
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
        placeholder="Name this node..."
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
      <span>{hasName ? node.name : "Name this section"}</span>
    </button>
  );
}

const DEFAULT_MAX_TOKENS = 256;
const COMMON_CONTEXT_SIZES = "8,192  |  16,384  |  32,768  |  65,536  |  131,072";

export default function App() {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [tree, setTree] = useState<Tree | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [buffer, setBuffer] = useState("");
  const [candidates, setCandidates] = useState<string[]>([]);
  const [candidatePrompt, setCandidatePrompt] = useState<string | null>(null);
  const [candidateBaseId, setCandidateBaseId] = useState<string | null>(null);
  const [candidateModelId, setCandidateModelId] = useState<string | null>(null);
  const [candidateSamplerSnapshot, setCandidateSamplerSnapshot] =
    useState<SamplerBody | null>(null);
  const [composition, setComposition] = useState("");
  const [branchCount, setBranchCount] = useState(3);
  const [maxTokens, setMaxTokens] = useState(DEFAULT_MAX_TOKENS);
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
  const [loadMaxSeqLen, setLoadMaxSeqLen] = useState(4096);
  const [loadCacheMode, setLoadCacheMode] = useState("Q6");
  const [downloadRepoId, setDownloadRepoId] = useState(
    "lucyknada/google_gemma-3-270m-exl3",
  );
  const [downloadRevision, setDownloadRevision] = useState("6.0bpw");
  const [downloadFolder, setDownloadFolder] = useState("");
  const [tokenCount, setTokenCount] = useState<number | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [presets, setPresets] = useState<SamplerPreset[]>([]);
  const [activePresetId, setActivePresetIdState] = useState<string | null>(null);
  const [draftBody, setDraftBody] = useState<SamplerBody>(() => neutralBody());
  const [samplerBusy, setSamplerBusy] = useState(false);
  const [samplerOpen, setSamplerOpen] = useState(false);
  const [collapsedNodes, setCollapsedNodes] = useState<Record<string, boolean>>(
    {},
  );
  const [treeWidth, setTreeWidth] = useState(288);
  const [pickerWidth, setPickerWidth] = useState(352);
  const abortRef = useRef<AbortController | null>(null);

  const branchPickerOpen = candidatePrompt !== null;
  const contextMax = modelContextMax(currentTabbyModel);
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
    setComposition("");
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

  const loadProject = useCallback(
    async (info: ProjectInfo) => {
      const nodes = await listNodes();
      const loaded = loadedTreeFromModels(nodes);
      setProject(info);
      setTree(loaded.tree);
      setCurrentId(loaded.currentId);
      setBuffer(concatPathText(pathFromRoot(loaded.tree, loaded.currentId)));
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

  const commitBuffer = useCallback(
    async (
      nextBuffer = buffer,
      source: NodeSource = "user_written",
    ): Promise<CommitResult | null> => {
      if (!project || !tree || !currentId) {
        setError("Create or open a project before saving.");
        return null;
      }
      if (streaming || saving || branchPickerOpen) return null;

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
    [branchPickerOpen, buffer, currentId, project, saving, streaming, tree],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void commitBuffer();
      }
      if (event.key === "Escape") {
        if (modelPanelOpen) {
          setModelPanelOpen(false);
        } else if (samplerOpen) {
          setSamplerOpen(false);
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commitBuffer, modelPanelOpen, samplerOpen]);

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
          max_seq_len: Math.max(256, Math.trunc(loadMaxSeqLen) || 4096),
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
    if (!tree || !currentId || streaming || saving || branchPickerOpen) return;

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

  async function onGenerate() {
    if (streaming || saving || branchPickerOpen) return;
    if (!currentTabbyModel) {
      setError("Load a model before generating.");
      return;
    }

    const committed = await commitBuffer(buffer, "user_written");
    if (!committed) return;

    const n = Math.max(1, Math.min(6, Math.trunc(branchCount) || 1));
    const promptSnapshot = committed.buffer;
    // Resolve the sampler snapshot *now* so a user tweaking the drawer
    // mid-stream doesn't retroactively change what a persisted node says
    // produced it.
    const samplerSnapshot = mergePreset(draftBody);
    setCandidates(Array.from({ length: n }, () => ""));
    setCandidatePrompt(promptSnapshot);
    setCandidateBaseId(committed.currentId);
    setCandidateModelId(currentTabbyModel.id);
    setCandidateSamplerSnapshot(samplerSnapshot);
    setComposition("");
    setError(null);
    setStreaming(true);
    abortRef.current = new AbortController();

    try {
      await streamCompletion(
        {
          prompt: promptSnapshot,
          n,
          max_tokens: Math.max(
            1,
            Math.trunc(maxTokens) || DEFAULT_MAX_TOKENS,
          ),
          ...samplerSnapshot,
        },
        (chunk) => {
          for (const choice of chunk.choices) {
            if (choice.index < 0 || choice.index >= n || !choice.text) continue;
            setCandidates((current) => {
              const next =
                current.length === n
                  ? [...current]
                  : Array.from({ length: n }, (_, index) => current[index] ?? "");
              next[choice.index] += choice.text;
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
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function onCancel() {
    abortRef.current?.abort();
  }

  async function persistBranchSelection(
    selectedText: string,
    selectedSource: NodeSource,
    selectedIndex: number | null,
  ) {
    if (
      !tree ||
      candidatePrompt === null ||
      candidateBaseId === null ||
      streaming ||
      saving
    ) {
      return;
    }
    if (!selectedText) {
      setError("Select a branch with text before committing.");
      return;
    }
    if (!tree.nodes[candidateBaseId]) {
      setError("The generation base no longer exists.");
      return;
    }

    const nextNodes: Record<string, TreeNode> = { ...tree.nodes };
    let selectedId: string | null = null;

    for (let index = 0; index < candidates.length; index++) {
      const text = candidates[index];
      if (!text) continue;
      const hidden =
        selectedSource === "generated" ? index !== selectedIndex : true;
      const node = branchNode(
        candidateBaseId,
        text,
        "generated",
        hidden,
        candidatePrompt,
        candidateModelId ?? undefined,
        candidateSamplerSnapshot ?? undefined,
      );
      nextNodes[node.id] = node;
      if (selectedSource === "generated" && index === selectedIndex) {
        selectedId = node.id;
      }
    }

    if (selectedSource === "composed") {
      const node = branchNode(
        candidateBaseId,
        selectedText,
        "composed",
        false,
        candidatePrompt,
      );
      nextNodes[node.id] = node;
      selectedId = node.id;
    }

    if (selectedId === null) {
      setError("Selected branch was empty.");
      return;
    }

    const nextTree = { nodes: nextNodes, rootId: tree.rootId };
    const path = pathFromRoot(nextTree, selectedId);
    const nextBuffer = concatPathText(path);

    setSaving(true);
    setError(null);
    try {
      await mutateNodes(mutationBatchFromTrees(tree, nextTree, selectedId));
      setTree(nextTree);
      setCurrentId(selectedId);
      setBuffer(nextBuffer);
      clearBranchPicker();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSaving(false);
    }
  }

  async function onChooseCandidate(index: number) {
    await persistBranchSelection(candidates[index] ?? "", "generated", index);
  }

  async function onCommitComposition() {
    await persistBranchSelection(composition, "composed", null);
  }

  const currentPath =
    tree && currentId ? pathFromRoot(tree, currentId) : [];
  const currentPathIds = new Set(currentPath.map((node) => node.id));
  const currentNode = tree && currentId ? tree.nodes[currentId] : null;
  const projectTitle =
    project?.title && project.title.trim() !== "Branching Workbook"
      ? project.title
      : null;

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

  function renderTreeNode(nodeIdToRender: string, depth = 0) {
    if (!tree) return null;
    const node = tree.nodes[nodeIdToRender];
    if (!node) return null;

    const childNodes = childrenOf(tree, node.id)
      .filter((child) => showHidden || !child.hidden)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const isCurrent = node.id === currentId;
    const isOnPath = currentPathIds.has(node.id);
    const hasChildren = childNodes.length > 0;
    const isCollapsed = !!collapsedNodes[node.id];

    return (
      <div key={node.id}>
        <div
          className="bw-tree-row-wrap"
          style={{ "--depth": `${depth * 0.85}rem` } as CSSProperties}
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
            onClick={() => void onSelectNode(node.id)}
            disabled={streaming || saving || branchPickerOpen}
            className="bw-tree-row"
            data-current={isCurrent}
            data-path={isOnPath}
            data-hidden={node.hidden}
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
              <span className="bw-status-sep" aria-hidden="true">·</span>
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
                onClick={() => void onCloseProject()}
                disabled={saving || streaming}
              >
                close project
              </button>
            </>
          )}
        </div>
      </header>

      {error && <div className="bw-error">{error}</div>}

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
                  disabled={!currentTabbyModel || modelBusy || streaming || branchPickerOpen}
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
                  A workbook is a single <code>.bwbk</code> file. Choose where it
                  lives — the app never remembers paths between sessions.
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
          style={{
            gridTemplateColumns: branchPickerOpen
              ? `${treeWidth}px 6px minmax(0, 1fr) 6px ${pickerWidth}px`
              : `${treeWidth}px 6px minmax(0, 1fr)`,
          }}
        >
          <aside className="bw-tree">
            <div className="bw-rail-head">
              <div>
                <div className="bw-kicker">Tree</div>
              </div>
              <label className="flex items-center gap-2 text-xs text-[color:var(--ink-muted)]">
                <input
                  type="checkbox"
                  checked={showHidden}
                  onChange={(event) => setShowHidden(event.target.checked)}
                />
                hidden
              </label>
            </div>
            <div className="bw-tree-list">{renderTreeNode(tree.rootId)}</div>
            <div className="bw-tree-foot">
              {Object.keys(tree.nodes).length.toLocaleString()} nodes
            </div>
          </aside>

          <div
            className="bw-splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize tree column"
            onMouseDown={(event) =>
              startColumnDrag(event, setTreeWidth, treeWidth, 1, 180, 480)
            }
          />

          <main className="bw-editor">
            <div className="bw-manuscript-scroll">
              <section className="bw-manuscript">
                {currentNode && (
                  <div className="mb-6">
                    <NodeNameEditor
                      node={currentNode}
                      disabled={saving || streaming || branchPickerOpen}
                      onRename={(name) => void onRenameCurrentNode(name)}
                    />
                  </div>
                )}
                <textarea
                  className="bw-buffer"
                  value={buffer}
                  onChange={(event) => setBuffer(event.target.value)}
                  disabled={branchPickerOpen}
                  placeholder="Start writing..."
                  spellCheck={false}
                />
              </section>
            </div>

            <footer className="bw-actionbar">
              <label className="bw-field">
                Preset
                <select
                  value={activePresetId ?? ""}
                  onChange={(event) =>
                    void onSelectPreset(event.target.value || null)
                  }
                  disabled={samplerBusy || streaming || branchPickerOpen}
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
              <label className="bw-field">
                Branches
                <input
                  type="number"
                  min={1}
                  max={6}
                  value={branchCount}
                  onChange={(event) => setBranchCount(Number(event.target.value))}
                  disabled={streaming || saving || branchPickerOpen}
                  className="bw-input w-16"
                />
              </label>
              <label className="bw-field">
                Max tokens
                <input
                  type="number"
                  min={1}
                  value={maxTokens}
                  onChange={(event) => setMaxTokens(Number(event.target.value))}
                  disabled={streaming || saving || branchPickerOpen}
                  className="bw-input w-24"
                />
              </label>
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => void onSave()}
                disabled={saving || streaming || branchPickerOpen}
                className="bw-button"
              >
                {saving ? "Saving" : "Save"}
              </button>
              {streaming ? (
                <button
                  type="button"
                  onClick={onCancel}
                  className="bw-button bw-button-primary"
                >
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void onGenerate()}
                  disabled={saving || branchPickerOpen || !currentTabbyModel}
                  className="bw-button bw-button-primary"
                >
                  Generate
                </button>
              )}
            </footer>
          </main>

          {branchPickerOpen && (
            <div
              className="bw-splitter"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize branches column"
              onMouseDown={(event) =>
                startColumnDrag(event, setPickerWidth, pickerWidth, -1, 240, 640)
              }
            />
          )}
          {branchPickerOpen && (
            <aside className="bw-picker">
              <div className="bw-picker-head">
                <div>
                  <div className="bw-kicker">Branches</div>
                  <div className="mt-1 text-xs text-[color:var(--ink-muted)]">
                    {streaming ? "streaming" : "ready"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={clearBranchPicker}
                  disabled={streaming || saving}
                  className="bw-button bw-button-quiet"
                >
                  Discard
                </button>
              </div>
              <div className="bw-picker-body">
                {candidates.map((text, index) => (
                  <section
                    key={index}
                    className="bw-branch-card"
                    data-empty={!text}
                  >
                    <div className="bw-branch-head">
                      <div className="bw-kicker">Branch {index + 1}</div>
                      <button
                        type="button"
                        onClick={() => void onChooseCandidate(index)}
                        disabled={!text || streaming || saving}
                        className="bw-button"
                      >
                        Use
                      </button>
                    </div>
                    <div className="bw-branch-text">
                      {text || (
                        <span className="bw-empty">
                          {streaming ? "Waiting for tokens..." : "No text."}
                        </span>
                      )}
                    </div>
                  </section>
                ))}

                <section className="bw-branch-card bw-compose-card">
                  <div className="bw-branch-head">
                    <div className="bw-kicker">Write your own</div>
                    <button
                      type="button"
                      onClick={() => void onCommitComposition()}
                      disabled={!composition.trim() || streaming || saving}
                      className="bw-button bw-button-primary"
                    >
                      Commit
                    </button>
                  </div>
                  <textarea
                    className="bw-textarea min-h-32 w-full resize-y p-3"
                    value={composition}
                    onChange={(event) => setComposition(event.target.value)}
                    placeholder="Compose from scratch or paste from the branches."
                    spellCheck={false}
                  />
                </section>
              </div>
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
