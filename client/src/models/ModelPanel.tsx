import type { ModelLoadEvent } from "../api";
import type { ModelLoader } from "./useModelLoader";

const COMMON_CONTEXT_SIZES = "8192  |  16384  |  32768  |  65536  |  131072";

function formatLoadEvent(event: ModelLoadEvent | null): string {
  if (!event) return "";
  return `${event.status} ${event.module}/${event.modules}`;
}

type ModelPanelProps = {
  /** The model-loader hook state/actions, owned by App. */
  models: ModelLoader;
  /** Whether a generation is streaming — load/unload are disabled during one. */
  streaming: boolean;
  /** Pre-formatted label for the current model (App also shows it in the header). */
  modelLabel: string;
  onClose: () => void;
};

/**
 * The TabbyAPI model-management modal: load a local model, unload, or download
 * one from Hugging Face. All state and actions come from {@link useModelLoader}
 * via the `models` prop; this component is purely the panel's markup.
 */
export default function ModelPanel({
  models,
  streaming,
  modelLabel,
  onClose,
}: ModelPanelProps) {
  const {
    currentTabbyModel,
    availableModels,
    loadingModels,
    modelBusy,
    modelLoadEvent,
    selectedModelName,
    setSelectedModelName,
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
    onRefreshModels,
    onLoadModel,
    onUnloadModel,
    onDownloadModel,
  } = models;

  return (
    <div
      className="bw-modal-backdrop"
      role="dialog"
      aria-label="Model management"
      onMouseDown={onClose}
    >
      <section className="bw-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="bw-modal-head">
          <div>
            <div className="bw-kicker">TabbyAPI</div>
            <div className="mt-1 font-serif text-xl">{modelLabel}</div>
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
              onClick={onClose}
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
                      onChange={(event) => setLoadTensorParallel(event.target.checked)}
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
  );
}
