import { useRef, useState } from "react";
import { streamCompletion } from "./api";

export default function App() {
  const [buffer, setBuffer] = useState(
    "The old lighthouse stood at the end of the pier, its beam sweeping across the harbor in long, slow arcs.",
  );
  const [candidate, setCandidate] = useState("");
  const [candidatePrompt, setCandidatePrompt] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  async function onGenerate() {
    if (streaming) return;
    const promptSnapshot = buffer;
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
              setCandidate((c) => c + choice.text);
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

  function onCommit() {
    if (!candidate || candidatePrompt === null) return;
    setBuffer(candidatePrompt + candidate);
    setCandidate("");
    setCandidatePrompt(null);
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 font-mono p-6">
      <div className="max-w-4xl mx-auto space-y-4">
        <div className="flex items-baseline justify-between">
          <div className="text-xs uppercase tracking-widest text-neutral-500">
            Branching Workbook
          </div>
          <div className="text-xs text-neutral-600">phase 1 · mock</div>
        </div>

        <div>
          <div className="text-xs text-neutral-500 mb-1">Buffer</div>
          <textarea
            className="w-full min-h-48 bg-neutral-900 border border-neutral-800 rounded p-3 text-neutral-100 resize-y focus:outline-none focus:border-neutral-600"
            value={buffer}
            onChange={(e) => setBuffer(e.target.value)}
            spellCheck={false}
          />
        </div>

        <div className="flex gap-2">
          <button
            onClick={onGenerate}
            disabled={streaming}
            className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed rounded transition-colors"
          >
            {streaming ? "Generating…" : "Generate"}
          </button>
          <button
            onClick={onCancel}
            disabled={!streaming}
            className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed rounded transition-colors"
          >
            Stop
          </button>
          <button
            onClick={onCommit}
            disabled={!candidate || streaming}
            className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed rounded transition-colors"
          >
            Commit
          </button>
        </div>

        <div>
          <div className="text-xs text-neutral-500 mb-1">Candidate</div>
          <div className="min-h-32 bg-neutral-900 border border-neutral-800 rounded p-3 whitespace-pre-wrap">
            {candidate || <span className="text-neutral-600">—</span>}
          </div>
        </div>

        {error && (
          <div className="text-sm text-red-400 bg-red-950/40 border border-red-900/60 rounded p-2">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
