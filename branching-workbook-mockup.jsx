import { useState, useEffect, useRef } from "react";
import {
  Settings,
  Play,
  Square,
  ChevronRight,
  ChevronDown,
  Eye,
  EyeOff,
  Circle,
  CircleDot,
  Pencil,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";

// --- Seed data ---------------------------------------------------------------

const SEED_NODES = {
  root: {
    id: "root",
    parentId: null,
    text: "",
    name: null,
    source: "root",
    hidden: false,
  },
  n1: {
    id: "n1",
    parentId: "root",
    text:
      "The lantern flickered once and then steadied, throwing long shadows across the stone floor of the abbey. Brother Thomas set down his pen.",
    name: "Opening",
    source: "user_written",
    hidden: false,
  },
  n2: {
    id: "n2",
    parentId: "n1",
    text:
      " He had been copying the same passage for three hours, and the Latin had begun to blur into meaningless shapes on the vellum.",
    name: null,
    source: "generated",
    hidden: false,
  },
  "n2-alt1": {
    id: "n2-alt1",
    parentId: "n1",
    text: " Outside, the wolves were singing to each other again.",
    name: null,
    source: "generated",
    hidden: true,
  },
  "n2-alt2": {
    id: "n2-alt2",
    parentId: "n1",
    text: " Someone was watching from the doorway, and had been for some time.",
    name: "The watcher (unused)",
    source: "generated",
    hidden: true,
  },
  n3: {
    id: "n3",
    parentId: "n2",
    text:
      " He rubbed his eyes and reached for the small cup of wine the abbot permitted him at this hour, though he was not supposed to drink it until vespers.",
    name: "Wine and weariness",
    source: "generated",
    hidden: false,
  },
};

const INITIAL_MAIN_PATH = ["root", "n1", "n2", "n3"];

const SAMPLE_CONTINUATIONS = [
  " The wine was thin and sour on his tongue. It tasted the way the abbey itself had come to taste — of penance, of winter, of the long quiet years in which nothing had happened and everything had changed. He drank the cup down in one swallow and set it on the sill, where the thin light of the moon turned it briefly into something more beautiful than it was.",
  " From the corridor came the slow, deliberate footsteps of someone who did not wish to be heard. Thomas set the cup down without drinking and listened. The abbey at this hour should have been silent. The brothers were at compline, the novices at prayer, and the kitchens cold until prime.",
  " He thought, not for the first time, of the letter hidden beneath the loose stone behind his cot, and of what it would cost him if anyone should find it. The bishop's seal. The queen's own hand. Three weeks since it had come to him through an intermediary he did not know, and in all that time he had not answered.",
  " A moth was beating itself against the lantern's glass, patient and stupid and doomed, as moths always are. Thomas watched it for a while. Then he took up his pen, dipped it, and began to write something that was not in the book at all.",
];

const PRESETS = {
  Balanced: { temperature: 1.0, top_p: 0.95, min_p: 0.03 },
  Wild: { temperature: 1.4, top_p: 1.0, min_p: 0.02, xtc_probability: 0.5 },
  Careful: { temperature: 0.7, top_p: 0.9, min_p: 0.05 },
  Strict: { temperature: 0.3, top_p: 0.8, min_p: 0.1 },
};

const TREE_WIDTH_MIN = 140;
const TREE_WIDTH_MAX = 480;
const TREE_WIDTH_DEFAULT = 240;

const PICKER_WIDTH_MIN = 280;
const PICKER_WIDTH_MAX = 640;
const PICKER_WIDTH_DEFAULT = 380;

// --- Helpers -----------------------------------------------------------------

function getAncestors(nodes, id) {
  const path = [];
  let cur = id;
  while (cur) {
    path.unshift(cur);
    cur = nodes[cur]?.parentId;
  }
  return path;
}

function getPathText(nodes, id) {
  return getAncestors(nodes, id)
    .map((nid) => nodes[nid].text)
    .join("");
}

function getChildren(nodes, id) {
  return Object.values(nodes).filter((n) => n.parentId === id);
}

function approxTokens(text) {
  return Math.ceil(text.length / 4);
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function nodeDisplayLabel(node) {
  if (node.name && node.name.trim()) return node.name.trim();
  const preview = node.text.trim().slice(0, 64);
  if (preview) return preview;
  return node.source === "root" ? "⟨root⟩" : "⟨empty⟩";
}

// --- Components --------------------------------------------------------------

function TreeNode({ nodeId, nodes, mainPath, currentId, showHidden, onSelect, depth = 0 }) {
  const node = nodes[nodeId];
  const [expanded, setExpanded] = useState(true);
  const children = getChildren(nodes, nodeId).filter((c) => showHidden || !c.hidden);
  const isOnMain = mainPath.includes(nodeId);
  const isCurrent = currentId === nodeId;
  const hasChildren = children.length > 0;
  const hasName = !!(node.name && node.name.trim());
  const label = nodeDisplayLabel(node);

  return (
    <div>
      <div
        onClick={() => onSelect(nodeId)}
        className={`flex items-start gap-1.5 py-1 pr-2 cursor-pointer group rounded-sm ${
          isCurrent ? "bg-stone-200/80" : "hover:bg-stone-200/40"
        }`}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(!expanded);
          }}
          className={`mt-[3px] shrink-0 ${hasChildren ? "text-stone-500" : "invisible"}`}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <div className="mt-[3px] shrink-0">
          {isOnMain ? (
            <CircleDot size={10} className={isCurrent ? "text-stone-900" : "text-stone-600"} />
          ) : (
            <Circle size={10} className={node.hidden ? "text-stone-400" : "text-stone-500"} />
          )}
        </div>
        <div
          className={`text-[12px] leading-[18px] truncate min-w-0 ${
            node.hidden
              ? "text-stone-400 italic"
              : hasName
              ? "text-stone-900"
              : isOnMain
              ? "text-stone-700"
              : "text-stone-600"
          } ${isCurrent ? "font-medium" : ""} ${!hasName && !node.hidden ? "italic" : ""}`}
          title={node.text}
        >
          {label}
        </div>
      </div>
      {expanded &&
        children.map((c) => (
          <TreeNode
            key={c.id}
            nodeId={c.id}
            nodes={nodes}
            mainPath={mainPath}
            currentId={currentId}
            showHidden={showHidden}
            onSelect={onSelect}
            depth={depth + 1}
          />
        ))}
    </div>
  );
}

function BranchPanel({ branch, onSelect, disabled }) {
  return (
    <div className="border border-stone-300 bg-[#fbfaf5] rounded-sm flex flex-col overflow-hidden shadow-[0_1px_0_rgba(0,0,0,0.02)] min-w-0">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-stone-200 bg-stone-50/60 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider font-sans text-stone-500">
            Branch {branch.id + 1}
          </span>
          {branch.status === "generating" && (
            <span className="flex items-center gap-1 text-[10px] text-stone-400">
              <span className="w-1 h-1 bg-stone-400 rounded-full animate-pulse" />
              {approxTokens(branch.text)} tok
            </span>
          )}
          {branch.status === "done" && (
            <span className="text-[10px] text-stone-400 font-sans">
              {approxTokens(branch.text)} tok
            </span>
          )}
        </div>
        {branch.status === "done" && !disabled && (
          <button
            onClick={() => onSelect(branch)}
            className="text-[11px] font-sans text-stone-700 hover:text-stone-900 hover:bg-stone-200 px-2 py-0.5 rounded-sm"
          >
            use
          </button>
        )}
      </div>
      <div
        className="px-4 py-3 font-serif text-[14px] leading-[22px] text-stone-800 max-h-64 overflow-y-auto min-w-0"
        style={{
          fontFamily:
            '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif',
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          minHeight: "3rem",
        }}
      >
        {branch.text || <span className="text-stone-300">…</span>}
      </div>
    </div>
  );
}

function NodeNameHeader({ node, onRename }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node?.name || "");
  const inputRef = useRef(null);

  useEffect(() => {
    // Reset draft when node changes
    setDraft(node?.name || "");
    setEditing(false);
  }, [node?.id]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  if (!node) return null;

  const commit = () => {
    const trimmed = draft.trim();
    onRename(trimmed || null);
    setEditing(false);
  };

  const cancel = () => {
    setDraft(node.name || "");
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            cancel();
          }
        }}
        placeholder="Name this node…"
        className="w-full bg-transparent border-b border-stone-400 outline-none font-serif text-[20px] text-stone-900 pb-1"
        style={{
          fontFamily:
            '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
        }}
      />
    );
  }

  const displayName = node.name && node.name.trim();

  return (
    <button
      onClick={() => setEditing(true)}
      className="group flex items-baseline gap-2 text-left w-full"
      title="Click to rename"
    >
      <span
        className={`font-serif text-[20px] pb-1 border-b border-transparent group-hover:border-stone-300 transition-colors ${
          displayName ? "text-stone-900" : "text-stone-400 italic"
        }`}
        style={{
          fontFamily:
            '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
        }}
      >
        {displayName || "Untitled"}
      </span>
      <Pencil
        size={12}
        className="text-stone-300 group-hover:text-stone-500 transition-colors shrink-0"
      />
    </button>
  );
}

function ModelBar({
  modelName,
  contextUsed,
  contextMax,
  onOpenSettings,
  onOpenModel,
  treeHidden,
  onToggleTree,
}) {
  const pct = contextUsed / contextMax;
  const warn = pct > 0.9;
  return (
    <div className="flex items-center justify-between px-4 py-2 border-b border-stone-200 bg-[#f6f3ea] text-[11px] font-sans text-stone-600 select-none">
      <div className="flex items-center gap-3">
        <button
          onClick={onToggleTree}
          className="text-stone-500 hover:text-stone-900"
          title={treeHidden ? "Show tree" : "Hide tree"}
        >
          {treeHidden ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
        </button>
        <span className="text-stone-900 font-medium tracking-tight">Branching Workbook</span>
        <span className="text-stone-400">·</span>
        <span>Untitled project</span>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={onOpenModel}
          className="flex items-center gap-1.5 hover:text-stone-900"
          title="Model"
        >
          <span className="w-1.5 h-1.5 bg-emerald-600 rounded-full" />
          <span>{modelName}</span>
        </button>
        <span className="text-stone-400">·</span>
        <span className={warn ? "text-amber-700" : ""}>
          {contextUsed.toLocaleString()} / {contextMax.toLocaleString()} tokens
        </span>
        <span className="text-stone-400">·</span>
        <button onClick={onOpenSettings} className="hover:text-stone-900" title="Settings">
          <Settings size={13} />
        </button>
      </div>
    </div>
  );
}

function ModelModal({ open, onClose, modelName, setModelName }) {
  if (!open) return null;
  const models = [
    {
      name: "Llama-3-70B-exl3-4.0bpw",
      size: "35.2 GB",
      loaded: modelName === "Llama-3-70B-exl3-4.0bpw",
    },
    {
      name: "Mistral-Large-123B-exl3-4.25bpw",
      size: "63.8 GB",
      loaded: modelName === "Mistral-Large-123B-exl3-4.25bpw",
    },
    {
      name: "Command-R-104B-exl3-4.0bpw",
      size: "52.0 GB",
      loaded: modelName === "Command-R-104B-exl3-4.0bpw",
    },
  ];
  return (
    <div
      className="fixed inset-0 bg-stone-900/30 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-[#fbfaf5] border border-stone-300 w-[560px] max-h-[80vh] rounded-sm shadow-xl font-sans flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-stone-200">
          <div className="text-sm font-medium text-stone-900">Models</div>
          <div className="text-xs text-stone-500 mt-0.5">Load or download a model via TabbyAPI</div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {models.map((m) => (
            <div
              key={m.name}
              className="flex items-center justify-between px-5 py-2.5 border-b border-stone-200/60 hover:bg-stone-100/50"
            >
              <div>
                <div className="text-[13px] text-stone-900 font-mono">{m.name}</div>
                <div className="text-[11px] text-stone-500 mt-0.5">{m.size}</div>
              </div>
              {m.loaded ? (
                <span className="text-[11px] text-emerald-700 uppercase tracking-wider">
                  loaded
                </span>
              ) : (
                <button
                  onClick={() => {
                    setModelName(m.name);
                    onClose();
                  }}
                  className="text-[11px] px-3 py-1 border border-stone-300 hover:border-stone-600 rounded-sm"
                >
                  load
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="px-5 py-3 border-t border-stone-200 bg-stone-50/50">
          <div className="text-[11px] text-stone-500 mb-2">Download from Hugging Face</div>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="repo_id (e.g. turboderp/Llama-3.1-70B-exl3)"
              className="flex-1 px-2 py-1 text-[12px] bg-white border border-stone-300 rounded-sm focus:outline-none focus:border-stone-600 font-mono"
            />
            <input
              type="text"
              placeholder="revision"
              defaultValue="main"
              className="w-24 px-2 py-1 text-[12px] bg-white border border-stone-300 rounded-sm focus:outline-none focus:border-stone-600 font-mono"
            />
            <button className="px-3 py-1 text-[11px] border border-stone-300 hover:border-stone-600 rounded-sm">
              download
            </button>
          </div>
        </div>
        <div className="px-5 py-2.5 border-t border-stone-200 flex justify-end">
          <button onClick={onClose} className="text-[12px] text-stone-600 hover:text-stone-900">
            close
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Main --------------------------------------------------------------------

export default function App() {
  const [nodes, setNodes] = useState(SEED_NODES);
  const [mainPath, setMainPath] = useState(INITIAL_MAIN_PATH);
  const [currentId, setCurrentId] = useState("n3");
  const [buffer, setBuffer] = useState(getPathText(SEED_NODES, "n3"));
  const [showHidden, setShowHidden] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [branches, setBranches] = useState([]);
  const [writeYourOwn, setWriteYourOwn] = useState("");
  const [activePreset, setActivePreset] = useState("Balanced");
  const [branchCount, setBranchCount] = useState(4);
  const [maxTokens, setMaxTokens] = useState(400);
  const [modelName, setModelName] = useState("Llama-3-70B-exl3-4.0bpw");
  const [modelModalOpen, setModelModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [treeWidth, setTreeWidth] = useState(TREE_WIDTH_DEFAULT);
  const [treeHidden, setTreeHidden] = useState(false);
  const [pickerWidth, setPickerWidth] = useState(PICKER_WIDTH_DEFAULT);
  const [resizingTree, setResizingTree] = useState(false);
  const [resizingPicker, setResizingPicker] = useState(false);
  const intervalsRef = useRef([]);

  // Tree resize handlers
  useEffect(() => {
    if (!resizingTree) return;
    const onMove = (e) => {
      const w = Math.max(TREE_WIDTH_MIN, Math.min(TREE_WIDTH_MAX, e.clientX));
      setTreeWidth(w);
    };
    const onUp = () => setResizingTree(false);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [resizingTree]);

  // Picker resize handlers (drag handle on left of picker, so width = viewport - clientX)
  useEffect(() => {
    if (!resizingPicker) return;
    const onMove = (e) => {
      const fromRight = window.innerWidth - e.clientX;
      const w = Math.max(PICKER_WIDTH_MIN, Math.min(PICKER_WIDTH_MAX, fromRight));
      setPickerWidth(w);
    };
    const onUp = () => setResizingPicker(false);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [resizingPicker]);

  const selectNode = (id) => {
    setCurrentId(id);
    setBuffer(getPathText(nodes, id));
    const newAncestors = getAncestors(nodes, id);
    setMainPath(newAncestors);
  };

  const renameCurrentNode = (newName) => {
    setNodes({
      ...nodes,
      [currentId]: { ...nodes[currentId], name: newName },
    });
  };

  const contextUsed = approxTokens(buffer);
  const contextMax = 32768;

  const stopGeneration = () => {
    intervalsRef.current.forEach((iv) => clearInterval(iv));
    intervalsRef.current = [];
    setGenerating(false);
  };

  const startGeneration = () => {
    if (generating) return;
    setGenerating(true);
    const charCap = maxTokens * 4;
    const picks = [...SAMPLE_CONTINUATIONS]
      .sort(() => Math.random() - 0.5)
      .slice(0, branchCount)
      .map((t, idx) => ({
        id: idx,
        text: "",
        fullText: t.slice(0, charCap),
        status: "generating",
      }));
    setBranches(picks);

    picks.forEach((br, i) => {
      let pos = 0;
      const iv = setInterval(() => {
        pos += 1 + Math.floor(Math.random() * 3);
        if (pos >= br.fullText.length) {
          pos = br.fullText.length;
          clearInterval(iv);
          setBranches((b) =>
            b.map((x) => (x.id === br.id ? { ...x, text: br.fullText, status: "done" } : x))
          );
        } else {
          const sliced = br.fullText.slice(0, pos);
          setBranches((b) => b.map((x) => (x.id === br.id ? { ...x, text: sliced } : x)));
        }
      }, 25 + i * 12 + Math.random() * 20);
      intervalsRef.current.push(iv);
    });
  };

  useEffect(() => {
    if (generating && branches.length > 0 && branches.every((b) => b.status === "done")) {
      setGenerating(false);
    }
  }, [branches, generating]);

  const commitBranchToBuffer = (text, source = "generated") => {
    const id = "n_" + uid();
    const newNode = {
      id,
      parentId: currentId,
      text,
      name: null,
      source,
      hidden: false,
    };
    const siblingNodes = branches
      .filter((b) => b.text !== text && b.status === "done")
      .map((b) => ({
        id: "n_" + uid(),
        parentId: currentId,
        text: b.text,
        name: null,
        source: "generated",
        hidden: true,
      }));
    const newNodes = { ...nodes, [id]: newNode };
    siblingNodes.forEach((n) => (newNodes[n.id] = n));
    setNodes(newNodes);
    setCurrentId(id);
    setMainPath([...mainPath, id]);
    setBuffer(buffer + text);
    setBranches([]);
    setWriteYourOwn("");
  };

  const submitWriteYourOwn = () => {
    if (!writeYourOwn.trim()) return;
    const text = writeYourOwn.startsWith(" ") ? writeYourOwn : " " + writeYourOwn;
    commitBranchToBuffer(text, "composed");
  };

  const pickerVisible = generating || branches.length > 0;
  const currentNode = nodes[currentId];

  const handleMaxTokensChange = (v) => {
    const n = parseInt(v, 10);
    if (isNaN(n)) {
      setMaxTokens(1);
      return;
    }
    setMaxTokens(Math.max(1, Math.min(8192, n)));
  };

  const anyResizing = resizingTree || resizingPicker;

  return (
    <div
      className={`h-screen w-screen flex flex-col bg-[#f6f3ea] text-stone-900 overflow-hidden ${
        anyResizing ? "cursor-col-resize select-none" : ""
      }`}
      style={{
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <ModelBar
        modelName={modelName}
        contextUsed={contextUsed}
        contextMax={contextMax}
        onOpenModel={() => setModelModalOpen(true)}
        onOpenSettings={() => setSettingsOpen(!settingsOpen)}
        treeHidden={treeHidden}
        onToggleTree={() => setTreeHidden(!treeHidden)}
      />

      {settingsOpen && (
        <div className="border-b border-stone-200 bg-[#f6f3ea] px-4 py-3 flex items-center gap-6 text-[11px] font-sans flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-stone-500 uppercase tracking-wider">Preset</span>
            <div className="flex gap-0.5">
              {Object.keys(PRESETS).map((name) => (
                <button
                  key={name}
                  onClick={() => setActivePreset(name)}
                  className={`px-2.5 py-1 rounded-sm transition-colors ${
                    activePreset === name
                      ? "bg-stone-800 text-stone-50"
                      : "text-stone-600 hover:bg-stone-200"
                  }`}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-stone-500 uppercase tracking-wider">Branches</span>
            {[1, 2, 4, 6, 8].map((n) => (
              <button
                key={n}
                onClick={() => setBranchCount(n)}
                className={`w-6 h-6 rounded-sm ${
                  branchCount === n
                    ? "bg-stone-800 text-stone-50"
                    : "text-stone-600 hover:bg-stone-200"
                }`}
              >
                {n}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <span className="text-stone-500 uppercase tracking-wider">Max tokens</span>
            <input
              type="number"
              value={maxTokens}
              onChange={(e) => handleMaxTokensChange(e.target.value)}
              min={1}
              max={8192}
              step={50}
              className="w-20 px-2 py-1 text-[12px] bg-white border border-stone-300 rounded-sm focus:outline-none focus:border-stone-600 font-mono text-stone-800"
            />
            <div className="flex gap-0.5">
              {[100, 200, 400, 800].map((n) => (
                <button
                  key={n}
                  onClick={() => setMaxTokens(n)}
                  className={`px-1.5 py-0.5 rounded-sm text-[10px] ${
                    maxTokens === n
                      ? "bg-stone-800 text-stone-50"
                      : "text-stone-500 hover:bg-stone-200"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 text-stone-500">
            <span className="font-mono text-stone-700">temp {PRESETS[activePreset].temperature}</span>
            <span>·</span>
            <span className="font-mono text-stone-700">top_p {PRESETS[activePreset].top_p}</span>
            <span>·</span>
            <span className="font-mono text-stone-700">min_p {PRESETS[activePreset].min_p}</span>
          </div>

          <div className="ml-auto">
            <button
              onClick={() => setSettingsOpen(false)}
              className="text-stone-500 hover:text-stone-900"
            >
              hide
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        {/* Tree sidebar */}
        {!treeHidden && (
          <>
            <aside
              className="shrink-0 border-r border-stone-200 bg-[#f2eee3] flex flex-col overflow-hidden"
              style={{ width: `${treeWidth}px` }}
            >
              <div className="flex items-center justify-between px-3 py-2 border-b border-stone-200/70">
                <span className="text-[10px] uppercase tracking-[0.12em] text-stone-500 font-sans">
                  Tree
                </span>
                <button
                  onClick={() => setShowHidden(!showHidden)}
                  className="text-stone-500 hover:text-stone-900"
                  title={showHidden ? "Hide hidden branches" : "Show hidden branches"}
                >
                  {showHidden ? <Eye size={13} /> : <EyeOff size={13} />}
                </button>
              </div>
              <div className="flex-1 overflow-y-auto py-1 font-sans">
                <TreeNode
                  nodeId="root"
                  nodes={nodes}
                  mainPath={mainPath}
                  currentId={currentId}
                  showHidden={showHidden}
                  onSelect={selectNode}
                />
              </div>
              <div className="border-t border-stone-200/70 px-3 py-2 text-[10px] text-stone-500 font-sans">
                {Object.keys(nodes).length} nodes ·{" "}
                {Object.values(nodes).filter((n) => n.hidden).length} hidden
              </div>
            </aside>
            {/* Tree resize handle */}
            <div
              onMouseDown={(e) => {
                e.preventDefault();
                setResizingTree(true);
              }}
              onDoubleClick={() => setTreeWidth(TREE_WIDTH_DEFAULT)}
              className="w-1 shrink-0 cursor-col-resize hover:bg-stone-300 active:bg-stone-400 transition-colors -ml-px"
              title="Drag to resize · double-click to reset"
            />
          </>
        )}

        {/* Buffer */}
        <main className="flex-1 flex flex-col min-w-0 bg-[#fbfaf5]">
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-[680px] mx-auto px-16 pt-12 pb-14">
              {/* Node name header */}
              <div className="mb-6">
                <NodeNameHeader node={currentNode} onRename={renameCurrentNode} />
              </div>

              <textarea
                value={buffer}
                onChange={(e) => setBuffer(e.target.value)}
                className="w-full bg-transparent resize-none outline-none text-stone-900 font-serif text-[17px] leading-[28px] tracking-[-0.002em]"
                style={{
                  fontFamily:
                    '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif',
                  minHeight: "calc(100vh - 280px)",
                }}
                placeholder="Start writing…"
                spellCheck={false}
              />
            </div>
          </div>

          {/* Bottom action bar */}
          <div className="border-t border-stone-200 bg-[#f6f3ea]/70 backdrop-blur-sm px-6 py-2.5 flex items-center gap-3 font-sans">
            <div className="text-[11px] text-stone-500 flex items-center gap-3">
              <span className="font-mono text-stone-700">{activePreset}</span>
              <span className="text-stone-400">·</span>
              <span>
                <span className="font-mono text-stone-700">{branchCount}</span> branches
              </span>
              <span className="text-stone-400">·</span>
              <span>
                <span className="font-mono text-stone-700">{maxTokens}</span> max tok
              </span>
            </div>
            <div className="flex-1" />
            {generating ? (
              <button
                onClick={stopGeneration}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-stone-800 text-stone-50 hover:bg-stone-900 rounded-sm text-[12px]"
              >
                <Square size={11} fill="currentColor" />
                stop
              </button>
            ) : (
              <button
                onClick={startGeneration}
                className="flex items-center gap-1.5 px-4 py-1.5 bg-stone-900 text-stone-50 hover:bg-black rounded-sm text-[12px] font-medium tracking-tight"
              >
                <Play size={11} fill="currentColor" />
                generate
              </button>
            )}
          </div>
        </main>

        {/* Branch picker (with resize handle on left) */}
        {pickerVisible && (
          <>
            <div
              onMouseDown={(e) => {
                e.preventDefault();
                setResizingPicker(true);
              }}
              onDoubleClick={() => setPickerWidth(PICKER_WIDTH_DEFAULT)}
              className="w-1 shrink-0 cursor-col-resize hover:bg-stone-300 active:bg-stone-400 transition-colors"
              title="Drag to resize · double-click to reset"
            />
            <aside
              className="shrink-0 border-l border-stone-200 bg-[#f2eee3] overflow-hidden"
              style={{ width: `${pickerWidth}px` }}
            >
              <div className="h-full flex flex-col min-w-0">
                <div className="flex items-center justify-between px-4 py-2 border-b border-stone-200/70">
                  <span className="text-[10px] uppercase tracking-[0.12em] text-stone-500 font-sans">
                    Branches
                  </span>
                  {generating && (
                    <button
                      onClick={stopGeneration}
                      className="text-[10px] text-stone-500 hover:text-stone-900 font-sans"
                    >
                      stop all
                    </button>
                  )}
                </div>
                <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5 min-w-0">
                  {branches.map((b) => (
                    <BranchPanel
                      key={b.id}
                      branch={b}
                      onSelect={() => commitBranchToBuffer(b.text, "generated")}
                      disabled={generating}
                    />
                  ))}

                  {/* Write-your-own box */}
                  {branches.length > 0 && (
                    <div className="border border-stone-300 border-dashed bg-[#fbfaf5] rounded-sm overflow-hidden min-w-0">
                      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-stone-200 bg-stone-50/60">
                        <Pencil size={10} className="text-stone-500" />
                        <span className="text-[10px] uppercase tracking-wider font-sans text-stone-500">
                          Write your own
                        </span>
                      </div>
                      <textarea
                        value={writeYourOwn}
                        onChange={(e) => setWriteYourOwn(e.target.value)}
                        className="w-full bg-transparent resize-none outline-none px-3 py-2 font-serif text-[13px] leading-[20px] text-stone-800"
                        style={{
                          fontFamily:
                            '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
                          overflowWrap: "anywhere",
                        }}
                        rows={4}
                        placeholder="Type or paste from the branches above…"
                      />
                      <div className="flex items-center justify-between px-3 py-1.5 border-t border-stone-200 bg-stone-50/60">
                        <span className="text-[10px] text-stone-400 font-sans">
                          {approxTokens(writeYourOwn)} tok
                        </span>
                        <button
                          onClick={submitWriteYourOwn}
                          disabled={!writeYourOwn.trim()}
                          className="text-[11px] font-sans px-2.5 py-0.5 bg-stone-800 text-stone-50 rounded-sm hover:bg-stone-900 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          submit
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </aside>
          </>
        )}
      </div>

      <ModelModal
        open={modelModalOpen}
        onClose={() => setModelModalOpen(false)}
        modelName={modelName}
        setModelName={setModelName}
      />
    </div>
  );
}
