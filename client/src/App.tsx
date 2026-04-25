import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  closeProject as closeProjectApi,
  createProject,
  createPreset,
  currentProject,
  currentModel,
  deletePreset,
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
  const [newPath, setNewPath] = useState("/tmp/branching-workbook.bwbk");
  const [newTitle, setNewTitle] = useState("Branching Workbook");
  const [openPath, setOpenPath] = useState("");
  const [presets, setPresets] = useState<SamplerPreset[]>([]);
  const [activePresetId, setActivePresetIdState] = useState<string | null>(null);
  const [draftBody, setDraftBody] = useState<SamplerBody>(() => neutralBody());
  const [samplerBusy, setSamplerBusy] = useState(false);
  const [samplerOpen, setSamplerOpen] = useState(false);
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
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commitBuffer]);

  async function onCreateProject(event: FormEvent) {
    event.preventDefault();
    if (!newPath.trim()) return;

    setLoadingProject(true);
    setError(null);
    try {
      const info = await createProject(newPath.trim(), newTitle.trim());
      await loadProject(info);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoadingProject(false);
    }
  }

  async function onOpenProject(event: FormEvent) {
    event.preventDefault();
    if (!openPath.trim()) return;

    setLoadingProject(true);
    setError(null);
    try {
      const info = await openProject(openPath.trim());
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

  function renderTreeNode(nodeIdToRender: string, depth = 0) {
    if (!tree) return null;
    const node = tree.nodes[nodeIdToRender];
    if (!node) return null;

    const childNodes = childrenOf(tree, node.id)
      .filter((child) => showHidden || !child.hidden)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const isCurrent = node.id === currentId;
    const isOnPath = currentPathIds.has(node.id);

    return (
      <div key={node.id}>
        <button
          type="button"
          onClick={() => void onSelectNode(node.id)}
          disabled={streaming || saving || branchPickerOpen}
          className={[
            "w-full text-left rounded border px-3 py-2 transition-colors",
            isCurrent
              ? "border-emerald-500/70 bg-emerald-950/30"
              : isOnPath
                ? "border-neutral-700 bg-neutral-900"
                : "border-neutral-800 bg-neutral-900/40 hover:border-neutral-700",
            node.hidden ? "opacity-50" : "",
          ].join(" ")}
          style={{ marginLeft: depth * 16 }}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-neutral-100">{previewText(node.text)}</span>
            <span className="shrink-0 text-[10px] uppercase tracking-widest text-neutral-500">
              {node.source}
            </span>
          </div>
          <div className="mt-1 text-[11px] text-neutral-600">{node.id}</div>
        </button>
        <div className="mt-1 space-y-1">
          {childNodes.map((child) => renderTreeNode(child.id, depth + 1))}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 font-mono p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-widest text-neutral-500">
              Branching Workbook
            </div>
            <div className="mt-1 text-lg text-neutral-100">
              {project?.title || "No project open"}
            </div>
          </div>
          <div className="text-xs text-neutral-600">
            phase 5 - model workflow
          </div>
        </div>

        {error && (
          <div className="rounded border border-red-900/60 bg-red-950/40 p-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <section className="rounded border border-neutral-800 bg-neutral-900/70 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-widest text-neutral-500">
                TabbyAPI
              </div>
              <div className="mt-1 text-sm text-neutral-100">
                {loadingModels ? "Checking model state..." : formatModelLabel(currentTabbyModel)}
              </div>
              <div
                className={[
                  "mt-1 text-xs",
                  contextWarn ? "text-amber-400" : "text-neutral-500",
                ].join(" ")}
              >
                Context:{" "}
                {tokenCount === null ? "unknown" : tokenCount.toLocaleString()}
                {" / "}
                {contextMax === null ? "unknown" : contextMax.toLocaleString()}
                {" tokens"}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => void onRefreshModels()}
                disabled={loadingModels || modelBusy}
                className="rounded bg-neutral-800 px-3 py-2 text-xs text-neutral-100 transition-colors hover:bg-neutral-700 disabled:opacity-40"
              >
                Refresh
              </button>
              <button
                onClick={() => void onUnloadModel()}
                disabled={!currentTabbyModel || modelBusy || streaming || branchPickerOpen}
                className="rounded bg-neutral-800 px-3 py-2 text-xs text-neutral-100 transition-colors hover:bg-neutral-700 disabled:opacity-40"
              >
                Unload
              </button>
            </div>
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="space-y-2">
              <div className="text-xs text-neutral-500">Load local model</div>
              <div className="flex flex-wrap gap-2">
                <select
                  value={selectedModelName}
                  onChange={(event) => setSelectedModelName(event.target.value)}
                  disabled={loadingModels || modelBusy}
                  className="min-w-64 flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-2 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none disabled:opacity-40"
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
                <input
                  type="number"
                  min={256}
                  step={256}
                  value={loadMaxSeqLen}
                  onChange={(event) => setLoadMaxSeqLen(Number(event.target.value))}
                  disabled={modelBusy}
                  className="w-28 rounded border border-neutral-800 bg-neutral-950 px-2 py-2 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none disabled:opacity-40"
                  title="max_seq_len"
                />
                <select
                  value={loadCacheMode}
                  onChange={(event) => setLoadCacheMode(event.target.value)}
                  disabled={modelBusy}
                  className="w-24 rounded border border-neutral-800 bg-neutral-950 px-2 py-2 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none disabled:opacity-40"
                >
                  <option value="Q4">Q4</option>
                  <option value="Q6">Q6</option>
                  <option value="Q8">Q8</option>
                  <option value="FP16">FP16</option>
                </select>
                <button
                  onClick={() => void onLoadModel()}
                  disabled={!selectedModelName || modelBusy || streaming}
                  className="rounded bg-neutral-100 px-4 py-2 text-sm text-neutral-950 disabled:opacity-40"
                >
                  {modelBusy && modelLoadEvent ? formatLoadEvent(modelLoadEvent) : "Load"}
                </button>
              </div>
              <div className="text-[11px] text-neutral-600">
                Common context sizes: {COMMON_CONTEXT_SIZES}
              </div>
            </div>

            <form onSubmit={(event) => void onDownloadModel(event)} className="space-y-2">
              <div className="text-xs text-neutral-500">
                Download from Hugging Face
              </div>
              <div className="flex flex-wrap gap-2">
                <input
                  value={downloadRepoId}
                  onChange={(event) => setDownloadRepoId(event.target.value)}
                  disabled={modelBusy}
                  placeholder="repo_id"
                  className="min-w-64 flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-2 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none disabled:opacity-40"
                />
                <input
                  value={downloadRevision}
                  onChange={(event) => setDownloadRevision(event.target.value)}
                  disabled={modelBusy}
                  placeholder="revision"
                  className="w-28 rounded border border-neutral-800 bg-neutral-950 px-2 py-2 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none disabled:opacity-40"
                />
                <input
                  value={downloadFolder}
                  onChange={(event) => setDownloadFolder(event.target.value)}
                  disabled={modelBusy}
                  placeholder="folder"
                  className="w-28 rounded border border-neutral-800 bg-neutral-950 px-2 py-2 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none disabled:opacity-40"
                />
                <button
                  type="submit"
                  disabled={!downloadRepoId.trim() || modelBusy || streaming}
                  className="rounded bg-neutral-800 px-4 py-2 text-sm text-neutral-100 transition-colors hover:bg-neutral-700 disabled:opacity-40"
                >
                  {modelBusy && !modelLoadEvent ? "Working..." : "Download"}
                </button>
              </div>
              <div className="text-[11px] text-neutral-600">
                Keep this request open; current TabbyAPI cancels downloads on disconnect.
              </div>
            </form>
          </div>
        </section>

        {!project && (
          <div className="grid gap-4 md:grid-cols-2">
            <form
              onSubmit={(event) => void onCreateProject(event)}
              className="space-y-3 rounded border border-neutral-800 bg-neutral-900/70 p-4"
            >
              <div className="text-sm text-neutral-300">Create project</div>
              <input
                className="w-full rounded border border-neutral-800 bg-neutral-950 p-2 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none"
                value={newPath}
                onChange={(event) => setNewPath(event.target.value)}
                placeholder="/path/to/project.bwbk"
              />
              <input
                className="w-full rounded border border-neutral-800 bg-neutral-950 p-2 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none"
                value={newTitle}
                onChange={(event) => setNewTitle(event.target.value)}
                placeholder="Project title"
              />
              <button
                type="submit"
                disabled={loadingProject}
                className="rounded bg-neutral-100 px-4 py-2 text-sm text-neutral-950 disabled:opacity-40"
              >
                Create
              </button>
            </form>

            <form
              onSubmit={(event) => void onOpenProject(event)}
              className="space-y-3 rounded border border-neutral-800 bg-neutral-900/70 p-4"
            >
              <div className="text-sm text-neutral-300">Open project</div>
              <input
                className="w-full rounded border border-neutral-800 bg-neutral-950 p-2 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none"
                value={openPath}
                onChange={(event) => setOpenPath(event.target.value)}
                placeholder="/path/to/project.bwbk"
              />
              <button
                type="submit"
                disabled={loadingProject}
                className="rounded bg-neutral-800 px-4 py-2 text-sm text-neutral-100 disabled:opacity-40"
              >
                Open
              </button>
            </form>
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

        {project && tree && currentId && (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
            <main className="space-y-4">
              <div className="rounded border border-neutral-800 bg-neutral-900/70 p-3 text-xs text-neutral-500">
                <div className="truncate">{project.path}</div>
                <div className="mt-1">
                  Current path: {currentPath.length} node
                  {currentPath.length === 1 ? "" : "s"}
                </div>
                <div className={contextWarn ? "mt-1 text-amber-400" : "mt-1"}>
                  Tokens:{" "}
                  {tokenCount === null ? "unknown" : tokenCount.toLocaleString()}
                  {" / "}
                  {contextMax === null ? "unknown" : contextMax.toLocaleString()}
                </div>
              </div>

              <div>
                <div className="mb-1 text-xs text-neutral-500">Buffer</div>
                <textarea
                  className="min-h-72 w-full resize-y rounded border border-neutral-800 bg-neutral-900 p-3 text-neutral-100 focus:border-neutral-600 focus:outline-none disabled:opacity-60"
                  value={buffer}
                  onChange={(event) => setBuffer(event.target.value)}
                  disabled={branchPickerOpen}
                  spellCheck={false}
                />
              </div>

              <div className="flex flex-wrap items-center gap-2 rounded border border-neutral-800 bg-neutral-900/70 px-3 py-2">
                <span className="text-xs uppercase tracking-widest text-neutral-500">
                  Sampler
                </span>
                <select
                  value={activePresetId ?? ""}
                  onChange={(event) =>
                    void onSelectPreset(event.target.value || null)
                  }
                  disabled={samplerBusy || streaming || branchPickerOpen}
                  className="min-w-40 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-100 focus:border-neutral-600 focus:outline-none disabled:opacity-40"
                >
                  <option value="">(none)</option>
                  {presets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name}
                    </option>
                  ))}
                </select>
                {draftDirty && (
                  <span className="text-xs text-amber-400" title="Unsaved changes">
                    *
                  </span>
                )}
                <button
                  onClick={() => setSamplerOpen(true)}
                  disabled={samplerBusy}
                  className="ml-auto rounded bg-neutral-800 px-3 py-1 text-xs text-neutral-100 transition-colors hover:bg-neutral-700 disabled:opacity-40"
                >
                  Edit
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-400">
                  Branches
                  <input
                    type="number"
                    min={1}
                    max={6}
                    value={branchCount}
                    onChange={(event) =>
                      setBranchCount(Number(event.target.value))
                    }
                    disabled={streaming || saving || branchPickerOpen}
                    className="w-14 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-neutral-100 focus:border-neutral-600 focus:outline-none disabled:opacity-40"
                  />
                </label>
                <label className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-400">
                  Max tokens
                  <input
                    type="number"
                    min={1}
                    value={maxTokens}
                    onChange={(event) =>
                      setMaxTokens(Number(event.target.value))
                    }
                    disabled={streaming || saving || branchPickerOpen}
                    className="w-20 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-neutral-100 focus:border-neutral-600 focus:outline-none disabled:opacity-40"
                  />
                </label>
                <button
                  onClick={() => void onSave()}
                  disabled={saving || streaming || branchPickerOpen}
                  className="rounded bg-neutral-100 px-4 py-2 text-sm text-neutral-950 disabled:opacity-40"
                >
                  {saving ? "Saving..." : "Save"}
                </button>
                <button
                  onClick={() => void onGenerate()}
                  disabled={
                    saving || streaming || branchPickerOpen || !currentTabbyModel
                  }
                  className="rounded bg-neutral-800 px-4 py-2 text-sm text-neutral-100 transition-colors hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {streaming ? "Generating..." : "Generate"}
                </button>
                <button
                  onClick={onCancel}
                  disabled={!streaming}
                  className="rounded bg-neutral-800 px-4 py-2 text-sm text-neutral-100 transition-colors hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Stop
                </button>
                <button
                  onClick={clearBranchPicker}
                  disabled={!branchPickerOpen || streaming || saving}
                  className="rounded bg-neutral-900 px-4 py-2 text-sm text-neutral-400 transition-colors hover:text-neutral-100 disabled:opacity-40"
                >
                  Discard candidates
                </button>
                <button
                  onClick={() => void onCloseProject()}
                  disabled={saving || streaming}
                  className="ml-auto rounded bg-neutral-900 px-4 py-2 text-sm text-neutral-400 transition-colors hover:text-neutral-100 disabled:opacity-40"
                >
                  Close
                </button>
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <div className="text-xs text-neutral-500">Branches</div>
                  {branchPickerOpen && (
                    <div className="text-xs text-neutral-600">
                      {streaming ? "streaming" : "ready"}
                    </div>
                  )}
                </div>

                {!branchPickerOpen && (
                  <div className="rounded border border-neutral-800 bg-neutral-900 p-3 text-sm text-neutral-600">
                    Generate from the current buffer to stream branch candidates.
                  </div>
                )}

                {branchPickerOpen && (
                  <div className="space-y-3">
                    <div className="grid gap-3 md:grid-cols-2">
                      {candidates.map((text, index) => (
                        <div
                          key={index}
                          className="rounded border border-neutral-800 bg-neutral-900 p-3"
                        >
                          <div className="mb-2 flex items-center justify-between">
                            <div className="text-xs uppercase tracking-widest text-neutral-500">
                              Branch {index + 1}
                            </div>
                            <button
                              onClick={() => void onChooseCandidate(index)}
                              disabled={!text || streaming || saving}
                              className="rounded bg-neutral-800 px-3 py-1 text-xs text-neutral-100 transition-colors hover:bg-neutral-700 disabled:opacity-40"
                            >
                              Choose
                            </button>
                          </div>
                          <div className="min-h-32 whitespace-pre-wrap text-sm text-neutral-100">
                            {text || (
                              <span className="text-neutral-600">
                                {streaming ? "Waiting for tokens..." : "No text."}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="rounded border border-neutral-800 bg-neutral-900 p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <div className="text-xs uppercase tracking-widest text-neutral-500">
                          Write your own
                        </div>
                        <button
                          onClick={() => void onCommitComposition()}
                          disabled={!composition.trim() || streaming || saving}
                          className="rounded bg-neutral-100 px-3 py-1 text-xs text-neutral-950 transition-colors disabled:opacity-40"
                        >
                          Commit composed
                        </button>
                      </div>
                      <textarea
                        className="min-h-28 w-full resize-y rounded border border-neutral-800 bg-neutral-950 p-3 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none"
                        value={composition}
                        onChange={(event) => setComposition(event.target.value)}
                        placeholder="Compose a branch from scratch or paste pieces from generated branches."
                        spellCheck={false}
                      />
                    </div>
                  </div>
                )}
              </div>
            </main>

            <aside className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-xs uppercase tracking-widest text-neutral-500">
                  Tree
                </div>
                <label className="flex items-center gap-2 text-xs text-neutral-500">
                  <input
                    type="checkbox"
                    checked={showHidden}
                    onChange={(event) => setShowHidden(event.target.checked)}
                  />
                  show hidden
                </label>
              </div>
              <div className="max-h-[calc(100vh-190px)] space-y-1 overflow-auto rounded border border-neutral-800 bg-neutral-950 p-2">
                {renderTreeNode(tree.rootId)}
              </div>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
