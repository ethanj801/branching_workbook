import { useEffect, useRef, useState } from "react";

import type { TreeNode } from "./tree/types";

/**
 * Inline click-to-edit control for a node's name. Shows the name (or a muted
 * placeholder) as a button; clicking swaps in a text input that commits on
 * Enter or blur and reverts on Escape. Used in the manuscript head and in
 * chat turn heads.
 */
export default function NodeNameEditor({
  node,
  disabled,
  placeholder = "Untitled section",
  onRename,
}: {
  node: TreeNode;
  disabled: boolean;
  placeholder?: string;
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
        placeholder={placeholder}
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
      title={hasName ? "Rename" : "Add a name"}
    >
      <span>{hasName ? node.name : placeholder}</span>
    </button>
  );
}
