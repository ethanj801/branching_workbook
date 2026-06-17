import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import {
  currentModel,
  downloadModel,
  listModels,
  streamModelLoad,
  unloadModel,
  type ModelLoadEvent,
  type ModelLoadRequest,
  type TabbyModel,
} from "../api";

export const DEFAULT_LOAD_MAX_SEQ_LEN = 65536;

export type ModelDownloadJob =
  | { phase: "idle" }
  | {
      phase: "downloading";
      repoId: string;
      modelName: string;
      startedAt: number;
    }
  | {
      phase: "completed";
      repoId: string;
      modelName: string;
      downloadPath: string;
    }
  | {
      phase: "failed";
      repoId: string;
      modelName: string;
      message: string;
    };

export function modelNameFromDownload(repoId: string, folderName: string): string {
  const explicitFolder = folderName.trim();
  if (explicitFolder) return explicitFolder;

  const repoLeaf = repoId
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1);
  return repoLeaf || repoId.trim();
}

export function selectedModelNameAfterDownload({
  currentSelection,
  selectionAtDownloadStart,
  downloadedModelName,
  selectionChangedDuringDownload,
}: {
  currentSelection: string;
  selectionAtDownloadStart: string;
  downloadedModelName: string;
  selectionChangedDuringDownload: boolean;
}): string {
  if (
    !currentSelection ||
    currentSelection === selectionAtDownloadStart ||
    (selectionAtDownloadStart === "" && !selectionChangedDuringDownload)
  ) {
    return downloadedModelName;
  }

  return currentSelection;
}

/** Parse a comma-separated GPU split like "20,20" into GB-per-GPU numbers. */
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

export type ModelLoaderOptions = {
  /** Surface (or clear, with null) an error message in the host UI. */
  setError: (message: string | null) => void;
  /** Render an unknown thrown value into a user-facing string. */
  formatError: (err: unknown) => string;
  /** Called after a model is unloaded, so the host can clear derived state. */
  onModelUnloaded: () => void;
};

/**
 * Owns everything about talking to TabbyAPI's model endpoints: the currently
 * loaded model, the available list, the load/download form state, and the
 * load/unload/download actions (including the streamed load progress event).
 *
 * Cross-cutting concerns the host App still owns — the global error banner and
 * the token-count readout — are passed in as callbacks rather than reached
 * into directly, so this hook has no dependency on the rest of App's state.
 */
export function useModelLoader({
  setError,
  formatError,
  onModelUnloaded,
}: ModelLoaderOptions) {
  const [currentTabbyModel, setCurrentTabbyModel] = useState<TabbyModel | null>(null);
  const [availableModels, setAvailableModels] = useState<TabbyModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelLoadEvent, setModelLoadEvent] = useState<ModelLoadEvent | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [downloadJob, setDownloadJob] = useState<ModelDownloadJob>({ phase: "idle" });
  const [selectedModelName, setSelectedModelName] = useState("");
  const downloadBusyRef = useRef(false);
  const selectionChangedDuringDownloadRef = useRef(false);
  const setUserSelectedModelName = useCallback<Dispatch<SetStateAction<string>>>(
    (value) => {
      setSelectedModelName((current) => {
        const next =
          typeof value === "function"
            ? (value as (previous: string) => string)(current)
            : value;
        if (downloadBusyRef.current && next !== current) {
          selectionChangedDuringDownloadRef.current = true;
        }
        return next;
      });
    },
    [],
  );
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
  }, [setError, formatError]);

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
      onModelUnloaded();
      await refreshModels();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setModelBusy(false);
    }
  }

  async function onDownloadModel() {
    const repoId = downloadRepoId.trim();
    if (!repoId || downloadBusy) return;

    const revision = downloadRevision.trim();
    const folderName = downloadFolder.trim();
    const modelName = modelNameFromDownload(repoId, folderName);
    const selectedModelNameAtStart = selectedModelName;
    downloadBusyRef.current = true;
    selectionChangedDuringDownloadRef.current = false;
    setDownloadBusy(true);
    setDownloadJob({
      phase: "downloading",
      repoId,
      modelName,
      startedAt: Date.now(),
    });
    setError(null);
    try {
      const response = await downloadModel({
        repo_id: repoId,
        revision: revision || undefined,
        folder_name: folderName || undefined,
      });
      await refreshModels();
      setSelectedModelName((current) =>
        selectedModelNameAfterDownload({
          currentSelection: current,
          selectionAtDownloadStart: selectedModelNameAtStart,
          downloadedModelName: modelName,
          selectionChangedDuringDownload: selectionChangedDuringDownloadRef.current,
        }),
      );
      setDownloadJob({
        phase: "completed",
        repoId,
        modelName,
        downloadPath: response.download_path,
      });
    } catch (err) {
      const message = formatError(err);
      setError(message);
      setDownloadJob({
        phase: "failed",
        repoId,
        modelName,
        message,
      });
    } finally {
      downloadBusyRef.current = false;
      setDownloadBusy(false);
    }
  }

  function clearDownloadJob() {
    if (!downloadBusy) setDownloadJob({ phase: "idle" });
  }

  return {
    currentTabbyModel,
    availableModels,
    loadingModels,
    modelBusy,
    modelLoadEvent,
    downloadBusy,
    downloadJob,
    selectedModelName,
    setSelectedModelName: setUserSelectedModelName,
    loadMaxSeqLen,
    setLoadMaxSeqLen,
    loadCacheMode,
    setLoadCacheMode,
    loadTensorParallel,
    setLoadTensorParallel,
    loadTensorParallelBackend,
    setLoadTensorParallelBackend,
    loadGpuSplit,
    setLoadGpuSplit,
    downloadRepoId,
    setDownloadRepoId,
    downloadRevision,
    setDownloadRevision,
    downloadFolder,
    setDownloadFolder,
    refreshModels,
    onRefreshModels,
    onLoadModel,
    onUnloadModel,
    onDownloadModel,
    clearDownloadJob,
  };
}

/** Everything {@link useModelLoader} returns — the prop shape for ModelPanel. */
export type ModelLoader = ReturnType<typeof useModelLoader>;
