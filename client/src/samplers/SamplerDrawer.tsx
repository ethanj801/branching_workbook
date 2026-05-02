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

type SectionOpenState = Record<string, boolean>;

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

function FieldLabel({ field }: { field: SamplerField }) {
  return (
    <span className="bw-sampler-label">
      <span>{field.label}</span>
      {field.info && (
        <span className="bw-info-dot" tabIndex={0} aria-label={field.info}>
          ?<span role="tooltip">{field.info}</span>
        </span>
      )}
    </span>
  );
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
      <label className="flex items-center gap-2 text-xs text-[color:var(--ink-muted)]">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            onChange(event.target.checked)
          }
          disabled={disabled}
          className="accent-[var(--accent)]"
        />
        <FieldLabel field={field} />
      </label>
    );
  }

  if (field.kind === "text") {
    return (
      <div>
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <FieldLabel field={field} />
        </div>
        <input
          type="text"
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          placeholder={field.info}
          className="bw-input w-full text-xs"
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
          <FieldLabel field={field} />
          <span
            className={`text-[11px] ${
              isNeutral ? "text-[color:var(--ink-faint)]" : "text-[color:var(--ink)]"
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
          className="bw-input w-full text-xs"
        />
      </div>
    );
  }

  // slider
  return (
    <div>
      <div className="mb-1 flex items-baseline gap-2">
        <FieldLabel field={field} />
        {!isNeutral && (
          <span className="text-[10px] uppercase tracking-wider text-[color:var(--ink-faint)]">
            edited
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={field.min}
          max={field.max}
          step={field.step}
          value={numericValue}
          onChange={(event) => onChange(Number(event.target.value))}
          disabled={disabled}
          className="flex-1 accent-[var(--accent)] disabled:opacity-40"
        />
        <input
          type="number"
          min={field.min}
          max={field.max}
          step={field.step}
          value={numericValue}
          onChange={(event) => onChange(Number(event.target.value))}
          disabled={disabled}
          className={`bw-input w-20 text-xs ${
            isNeutral ? "text-[color:var(--ink-muted)]" : "text-[color:var(--ink)]"
          }`}
        />
      </div>
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
  const [openSections, setOpenSections] = useState<SectionOpenState>({
    core: true,
  });

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

  function toggleSection(sectionId: string) {
    setOpenSections((current) => ({
      ...current,
      [sectionId]: !current[sectionId],
    }));
  }

  return (
    <div
      className="bw-drawer-backdrop justify-end"
      role="dialog"
      aria-label="Sampler presets"
    >
      <button
        type="button"
        aria-label="Close sampler drawer"
        onClick={onClose}
        className="absolute inset-0 border-0 bg-transparent"
      />
      <aside className="relative flex h-full w-full max-w-md flex-col overflow-hidden border-l border-[color:var(--line-dark)] bg-[color:var(--editor)] shadow-[var(--shadow)]">
        <header className="border-b border-[color:var(--line)] p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="bw-kicker">Samplers</div>
              {activePreset ? (
                <div className="mt-1 font-serif text-xl text-[color:var(--ink)]">
                  {activePreset.name}
                  {dirty && <span className="ml-1 text-[color:var(--warn)]">*</span>}
                </div>
              ) : (
                <div className="mt-1 text-sm text-[color:var(--ink-muted)]">
                  No preset active
                </div>
              )}
            </div>
            <button onClick={onClose} className="bw-button bw-button-quiet">
              Close
            </button>
          </div>

          <div className="mt-3 space-y-2">
            <label className="flex items-center gap-2 text-xs text-[color:var(--ink-muted)]">
              Preset
              <select
                value={activePresetId ?? ""}
                onChange={(event) => onSelectPreset(event.target.value || null)}
                disabled={busy || !projectOpen}
                className="bw-select flex-1 text-xs"
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
              <div className="text-[11px] text-[color:var(--ink-faint)]">
                Open a project to activate a preset for it.
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                onClick={onSaveChanges}
                disabled={!canModifyActive || !dirty || busy}
                className="bw-button bw-button-primary text-xs"
                title="Save changes into the active preset"
              >
                Save
              </button>
              <button
                onClick={onNeutralize}
                disabled={busy}
                className="bw-button text-xs"
                title="Reset every sampler to its neutral default"
              >
                Neutralize
              </button>
              <button
                onClick={() => {
                  if (!activePreset) return;
                  if (
                    confirm(`Delete preset "${activePreset.name}"? This is permanent.`)
                  ) {
                    onDeletePreset(activePreset.id);
                  }
                }}
                disabled={!canModifyActive || busy}
                className="bw-button text-xs text-[color:var(--warn)]"
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
                className="bw-input flex-1 text-xs"
              />
              <button
                onClick={() => {
                  const trimmed = saveAsName.trim();
                  if (!trimmed) return;
                  onSaveAs(trimmed);
                  setSaveAsName("");
                }}
                disabled={!saveAsName.trim() || busy}
                className="bw-button text-xs"
              >
                Save as
              </button>
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-4">
          {SAMPLER_SECTIONS.map((section) => {
            const expanded = !!openSections[section.id];
            return (
              <section
                key={section.id}
                className="bw-sampler-section"
                data-open={expanded}
              >
                <button
                  type="button"
                  className="bw-sampler-section-head"
                  onClick={() => toggleSection(section.id)}
                  aria-expanded={expanded}
                >
                  <span>{section.title}</span>
                  <span aria-hidden="true">{expanded ? "⌄" : "›"}</span>
                </button>
                {expanded && (
                  <div className="bw-sampler-section-body">
                    {section.fields.map((field) => (
                      <div key={field.key as string}>
                        <SliderControl
                          field={field}
                          // @ts-expect-error indexed access returns the field's value type
                          value={resolvedDraft[field.key] ?? field.neutral}
                          onChange={(v) => updateField(field, v)}
                          disabled={busy}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
