import { useMemo, useState, type ChangeEvent } from "react";

import type { SamplerBody, SamplerPreset } from "../api";
import { SAMPLER_SECTIONS, neutralBody, type SamplerField } from "./fields";

type Props = {
  open: boolean;
  presets: SamplerPreset[];
  activePresetId: string | null;
  draft: SamplerBody;
  busy: boolean;
  dirty: boolean;
  projectOpen: boolean;
  onClose: () => void;
  onSelectPreset: (id: string | null) => void;
  onDraftChange: (body: SamplerBody) => void;
  onSaveChanges: () => void;
  onSaveAs: (name: string) => void;
  onDeletePreset: (id: string) => void;
  onNeutralize: () => void;
};

type DraftValue = string | number | boolean;

function applyDraftChange(
  draft: SamplerBody,
  field: SamplerField,
  value: DraftValue,
): SamplerBody {
  const next: SamplerBody = { ...draft };
  // @ts-expect-error value type matches field.key by construction
  next[field.key] = value;
  return next;
}

function SliderControl({
  field,
  value,
  onChange,
  disabled,
}: {
  field: SamplerField;
  value: DraftValue;
  onChange: (v: DraftValue) => void;
  disabled: boolean;
}) {
  if (field.kind === "checkbox") {
    return (
      <label className="flex items-center gap-2 text-xs text-neutral-300">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            onChange(event.target.checked)
          }
          disabled={disabled}
          className="accent-emerald-500"
        />
        <span className="font-mono text-neutral-400">{field.label}</span>
      </label>
    );
  }

  if (field.kind === "text") {
    return (
      <div>
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <span className="font-mono text-xs text-neutral-400">{field.label}</span>
        </div>
        <input
          type="text"
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          placeholder={field.info}
          className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-100 focus:border-neutral-600 focus:outline-none disabled:opacity-40"
        />
      </div>
    );
  }

  const numericValue = typeof value === "number" ? value : Number(field.neutral);
  const isNeutral = numericValue === field.neutral;

  if (field.kind === "number") {
    return (
      <div>
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <span className="font-mono text-xs text-neutral-400">{field.label}</span>
          <span
            className={`font-mono text-[11px] ${
              isNeutral ? "text-neutral-600" : "text-neutral-100"
            }`}
          >
            {numericValue}
          </span>
        </div>
        <input
          type="number"
          value={numericValue}
          min={field.min}
          max={field.max}
          step={field.step}
          onChange={(event) => onChange(Number(event.target.value))}
          disabled={disabled}
          className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-100 focus:border-neutral-600 focus:outline-none disabled:opacity-40"
        />
      </div>
    );
  }

  // slider
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="font-mono text-xs text-neutral-400">{field.label}</span>
        <span
          className={`font-mono text-[11px] ${
            isNeutral ? "text-neutral-600" : "text-neutral-100"
          }`}
        >
          {numericValue}
        </span>
      </div>
      <input
        type="range"
        min={field.min}
        max={field.max}
        step={field.step}
        value={numericValue}
        onChange={(event) => onChange(Number(event.target.value))}
        disabled={disabled}
        className="w-full accent-emerald-500 disabled:opacity-40"
      />
    </div>
  );
}

export default function SamplerDrawer({
  open,
  presets,
  activePresetId,
  draft,
  busy,
  dirty,
  projectOpen,
  onClose,
  onSelectPreset,
  onDraftChange,
  onSaveChanges,
  onSaveAs,
  onDeletePreset,
  onNeutralize,
}: Props) {
  const [saveAsName, setSaveAsName] = useState("");

  const activePreset = useMemo(
    () => presets.find((p) => p.id === activePresetId) ?? null,
    [presets, activePresetId],
  );
  const canModifyActive = activePreset !== null;

  if (!open) return null;

  const resolvedDraft = { ...neutralBody(), ...draft };

  function updateField(field: SamplerField, value: DraftValue) {
    onDraftChange(applyDraftChange(draft, field, value));
  }

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end"
      role="dialog"
      aria-label="Sampler presets"
    >
      <button
        type="button"
        aria-label="Close sampler drawer"
        onClick={onClose}
        className="absolute inset-0 bg-black/50"
      />
      <aside className="relative flex h-full w-full max-w-md flex-col overflow-hidden border-l border-neutral-800 bg-neutral-950 shadow-xl">
        <header className="border-b border-neutral-800 p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-widest text-neutral-500">
                Samplers
              </div>
              <div className="mt-1 text-sm text-neutral-100">
                {activePreset ? activePreset.name : "(no preset selected)"}
                {dirty && <span className="ml-1 text-amber-400">*</span>}
              </div>
            </div>
            <button
              onClick={onClose}
              className="rounded bg-neutral-800 px-3 py-1 text-xs text-neutral-100 transition-colors hover:bg-neutral-700"
            >
              Close
            </button>
          </div>

          <div className="mt-3 space-y-2">
            <label className="flex items-center gap-2 text-xs text-neutral-500">
              Preset
              <select
                value={activePresetId ?? ""}
                onChange={(event) =>
                  onSelectPreset(event.target.value || null)
                }
                disabled={busy || !projectOpen}
                className="flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-100 focus:border-neutral-600 focus:outline-none disabled:opacity-40"
              >
                <option value="">(none)</option>
                {presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.is_starter ? `${preset.name} (starter)` : preset.name}
                  </option>
                ))}
              </select>
            </label>
            {!projectOpen && (
              <div className="text-[11px] text-neutral-600">
                Open a project to activate a preset for it.
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                onClick={onSaveChanges}
                disabled={!canModifyActive || !dirty || busy}
                className="rounded bg-neutral-100 px-3 py-1 text-xs text-neutral-950 transition-colors disabled:opacity-40"
                title="Save changes into the active preset"
              >
                Save
              </button>
              <button
                onClick={onNeutralize}
                disabled={busy}
                className="rounded bg-neutral-800 px-3 py-1 text-xs text-neutral-100 transition-colors hover:bg-neutral-700 disabled:opacity-40"
                title="Reset every sampler to its neutral default"
              >
                Neutralize
              </button>
              <button
                onClick={() => {
                  if (!activePreset) return;
                  if (
                    confirm(
                      `Delete preset "${activePreset.name}"? This is permanent.`,
                    )
                  ) {
                    onDeletePreset(activePreset.id);
                  }
                }}
                disabled={!canModifyActive || busy}
                className="rounded bg-neutral-800 px-3 py-1 text-xs text-red-400 transition-colors hover:bg-neutral-700 disabled:opacity-40"
                title="Delete the active preset"
              >
                Delete
              </button>
            </div>

            <div className="flex gap-2">
              <input
                value={saveAsName}
                onChange={(event) => setSaveAsName(event.target.value)}
                placeholder="Save current as..."
                disabled={busy}
                className="flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-100 focus:border-neutral-600 focus:outline-none disabled:opacity-40"
              />
              <button
                onClick={() => {
                  const trimmed = saveAsName.trim();
                  if (!trimmed) return;
                  onSaveAs(trimmed);
                  setSaveAsName("");
                }}
                disabled={!saveAsName.trim() || busy}
                className="rounded bg-neutral-800 px-3 py-1 text-xs text-neutral-100 transition-colors hover:bg-neutral-700 disabled:opacity-40"
              >
                Save as
              </button>
            </div>
          </div>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          {SAMPLER_SECTIONS.map((section) => (
            <section key={section.id} className="space-y-3">
              <div className="text-xs uppercase tracking-widest text-neutral-500">
                {section.title}
              </div>
              {section.fields.map((field) => (
                <div key={field.key as string}>
                  <SliderControl
                    field={field}
                    // @ts-expect-error indexed access returns the field's value type
                    value={resolvedDraft[field.key] ?? field.neutral}
                    onChange={(v) => updateField(field, v)}
                    disabled={busy}
                  />
                  {field.info && (
                    <div className="mt-1 text-[10px] text-neutral-600">
                      {field.info}
                    </div>
                  )}
                </div>
              ))}
            </section>
          ))}
        </div>
      </aside>
    </div>
  );
}
