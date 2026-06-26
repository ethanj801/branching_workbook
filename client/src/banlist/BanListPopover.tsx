import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import Switch from "../Switch";

type Props = {
  bannedStrings: string[];
  enabled: boolean;
  onAdd: (phrase: string) => void;
  onRemoveAt: (index: number) => void;
  onToggleEnabled: () => void;
  onClose: () => void;
};

export default function BanListPopover({
  bannedStrings,
  enabled,
  onAdd,
  onRemoveAt,
  onToggleEnabled,
  onClose,
}: Props) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function commit() {
    onAdd(draft);
    setDraft("");
    inputRef.current?.focus();
  }

  // Enter commits the phrase. Shift+Enter inserts a newline so a single banned
  // phrase can span lines.
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      commit();
    }
  }

  const count = bannedStrings.length;

  return (
    <div className="bw-banlist-popover" role="dialog" aria-label="Banned phrases">
      <div className="bw-banlist-head">
        <span className="bw-kicker">Banned phrases</span>
        <div className="bw-banlist-head-right">
          <span className="bw-banlist-count">
            {count} {count === 1 ? "phrase" : "phrases"}
          </span>
          <button
            type="button"
            className="bw-banlist-close"
            aria-label="Close banned phrases"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
      </div>

      <div className="bw-banlist-subhead">
        <Switch label="Enabled" checked={enabled} onChange={onToggleEnabled} />
      </div>

      <div className="bw-banlist-add">
        <textarea
          ref={inputRef}
          className="bw-input bw-banlist-input"
          rows={1}
          value={draft}
          placeholder="Add a phrase…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="bw-button"
          onClick={commit}
          disabled={draft.trim() === ""}
        >
          Add
        </button>
      </div>
      <div className="bw-banlist-hint">Enter to add · Shift+Enter for a newline</div>

      <div className="bw-banlist-rows" data-disabled={!enabled}>
        {count === 0 ? (
          <div className="bw-banlist-empty">No banned phrases yet.</div>
        ) : (
          bannedStrings.map((phrase, index) => (
            <div className="bw-banlist-row" key={`${phrase}-${index}`}>
              <span className="bw-banlist-phrase">{phrase}</span>
              <button
                type="button"
                className="bw-banlist-remove"
                aria-label={`Remove ${phrase}`}
                onClick={() => onRemoveAt(index)}
              >
                ✕
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
