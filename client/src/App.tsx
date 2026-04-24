import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  closeProject as closeProjectApi,
  createProject,
  currentProject,
  listNodes,
  mutateNodes,
  openProject,
  streamCompletion,
  type ProjectInfo,
} from "./api";
import { loadedTreeFromModels, mutationBatchFromTrees } from "./tree/persistence";
import { reshape } from "./tree/reshape";
import {
  childrenOf,
  concatPathText,
  pathFromRoot,
  type NodeSource,
  type Tree,
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

export default function App() {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [tree, setTree] = useState<Tree | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [buffer, setBuffer] = useState("");
  const [candidate, setCandidate] = useState("");
  const [candidatePrompt, setCandidatePrompt] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingProject, setLoadingProject] = useState(true);
  const [showHidden, setShowHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newPath, setNewPath] = useState("/tmp/branching-workbook.bwbk");
  const [newTitle, setNewTitle] = useState("Branching Workbook");
  const [openPath, setOpenPath] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const loadProject = useCallback(async (info: ProjectInfo) => {
    const nodes = await listNodes();
    const loaded = loadedTreeFromModels(nodes);
    setProject(info);
    setTree(loaded.tree);
    setCurrentId(loaded.currentId);
    setBuffer(concatPathText(pathFromRoot(loaded.tree, loaded.currentId)));
    setCandidate("");
    setCandidatePrompt(null);
  }, []);

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

  const commitBuffer = useCallback(
    async (
      nextBuffer = buffer,
      source: NodeSource = "user_written",
    ): Promise<CommitResult | null> => {
      if (!project || !tree || !currentId) {
        setError("Create or open a project before saving.");
        return null;
      }
      if (streaming) return null;
      if (saving) return null;

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
      setCandidate("");
      setCandidatePrompt(null);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoadingProject(false);
    }
  }

  async function onSave() {
    await commitBuffer();
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

  async function onGenerate() {
    if (streaming || saving) return;

    const committed = await commitBuffer(buffer, "user_written");
    if (!committed) return;

    const promptSnapshot = committed.buffer;
    setCandidate("");
    setCandidatePrompt(promptSnapshot);
    setError(null);
    setStreaming(true);
    abortRef.current = new AbortController();

    try {
      await streamCompletion(
        { prompt: promptSnapshot, n: 1, max_tokens: 200 },
        (chunk) => {
          for (const choice of chunk.choices) {
            if (choice.index === 0 && choice.text) {
              setCandidate((current) => current + choice.text);
            }
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

  async function onCommitCandidate() {
    if (!candidate || candidatePrompt === null || streaming || saving) return;

    const committed = await commitBuffer(candidatePrompt + candidate, "generated");
    if (!committed) return;

    setCandidate("");
    setCandidatePrompt(null);
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
          disabled={streaming || saving}
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
            phase 2 - sqlite tree
          </div>
        </div>

        {error && (
          <div className="rounded border border-red-900/60 bg-red-950/40 p-2 text-sm text-red-300">
            {error}
          </div>
        )}

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

        {project && tree && currentId && (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
            <main className="space-y-4">
              <div className="rounded border border-neutral-800 bg-neutral-900/70 p-3 text-xs text-neutral-500">
                <div className="truncate">{project.path}</div>
                <div className="mt-1">
                  Current path: {currentPath.length} node
                  {currentPath.length === 1 ? "" : "s"}
                </div>
              </div>

              <div>
                <div className="mb-1 text-xs text-neutral-500">Buffer</div>
                <textarea
                  className="min-h-72 w-full resize-y rounded border border-neutral-800 bg-neutral-900 p-3 text-neutral-100 focus:border-neutral-600 focus:outline-none"
                  value={buffer}
                  onChange={(event) => setBuffer(event.target.value)}
                  spellCheck={false}
                />
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => void onSave()}
                  disabled={saving || streaming}
                  className="rounded bg-neutral-100 px-4 py-2 text-sm text-neutral-950 disabled:opacity-40"
                >
                  {saving ? "Saving..." : "Save"}
                </button>
                <button
                  onClick={() => void onGenerate()}
                  disabled={saving || streaming}
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
                  onClick={() => void onCommitCandidate()}
                  disabled={!candidate || streaming || saving}
                  className="rounded bg-neutral-800 px-4 py-2 text-sm text-neutral-100 transition-colors hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Commit candidate
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
                <div className="mb-1 text-xs text-neutral-500">Candidate</div>
                <div className="min-h-32 rounded border border-neutral-800 bg-neutral-900 p-3 whitespace-pre-wrap">
                  {candidate || (
                    <span className="text-neutral-600">
                      Generate from the current buffer to stream a candidate.
                    </span>
                  )}
                </div>
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
