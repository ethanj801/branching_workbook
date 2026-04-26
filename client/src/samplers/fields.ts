import type { SamplerBody } from "../api";

/**
 * Declarative catalog of every sampler field we expose in the UI.
 *
 * Field names match TabbyAPI's `BaseSamplerRequest` canonical names
 * (not ooba aliases): dynamic-temperature is `min_temp`/`max_temp`/
 * `temp_exponent`, rep-penalty range is `penalty_range`, etc. Fields NOT
 * in TabbyAPI's schema (seed, top_n_sigma, epsilon_cutoff, eta_cutoff,
 * smoothing_curve) are intentionally omitted — the server would ignore
 * them and the slider would look broken.
 *
 * Numeric ranges come from ooba's UI (modules/ui_parameters.py) for
 * familiarity. `neutral` is the value that makes the sampler a no-op
 * (what "Neutralize Samplers" resets to).
 */

export type SliderField = {
  kind: "slider";
  key: keyof SamplerBody;
  label: string;
  min: number;
  max: number;
  step: number;
  neutral: number;
  info?: string;
};

export type NumberField = {
  kind: "number";
  key: keyof SamplerBody;
  label: string;
  min?: number;
  max?: number;
  step: number;
  neutral: number;
  info?: string;
};

export type CheckboxField = {
  kind: "checkbox";
  key: keyof SamplerBody;
  label: string;
  neutral: boolean;
  info?: string;
};

export type TextField = {
  kind: "text";
  key: keyof SamplerBody;
  label: string;
  neutral: string;
  info?: string;
};

export type SamplerField =
  | SliderField
  | NumberField
  | CheckboxField
  | TextField;

export type SamplerSection = {
  id: string;
  title: string;
  fields: SamplerField[];
};

export const SAMPLER_SECTIONS: SamplerSection[] = [
  {
    id: "core",
    title: "Core",
    fields: [
      {
        kind: "slider",
        key: "temperature",
        label: "temperature",
        min: 0.01,
        max: 5,
        step: 0.01,
        neutral: 1,
      },
      {
        kind: "slider",
        key: "top_p",
        label: "top_p",
        min: 0,
        max: 1,
        step: 0.01,
        neutral: 1,
      },
      {
        kind: "slider",
        key: "min_p",
        label: "min_p",
        min: 0,
        max: 1,
        step: 0.01,
        neutral: 0,
      },
      {
        kind: "slider",
        key: "top_k",
        label: "top_k",
        min: 0,
        max: 200,
        step: 1,
        neutral: 0,
      },
    ],
  },
  {
    id: "anti-repetition",
    title: "Anti-repetition",
    fields: [
      {
        kind: "slider",
        key: "dry_multiplier",
        label: "dry_multiplier",
        min: 0,
        max: 5,
        step: 0.01,
        neutral: 0,
        info: "0 disables DRY. Recommended around 0.8 when enabled.",
      },
      {
        kind: "slider",
        key: "dry_base",
        label: "dry_base",
        min: 1,
        max: 4,
        step: 0.01,
        neutral: 1.75,
      },
      {
        kind: "slider",
        key: "dry_allowed_length",
        label: "dry_allowed_length",
        min: 1,
        max: 20,
        step: 1,
        neutral: 2,
      },
      {
        kind: "number",
        key: "dry_range",
        label: "dry_range",
        min: 0,
        step: 1,
        neutral: 0,
        info: "Context window, in tokens, that DRY looks back over. 0 means whole context.",
      },
      {
        kind: "text",
        key: "dry_sequence_breakers",
        label: "dry_sequence_breakers",
        neutral: "",
        info: 'Comma-separated strings that break DRY matching, for example "\\n" or ".".',
      },
      {
        kind: "slider",
        key: "repetition_penalty",
        label: "repetition_penalty",
        min: 1,
        max: 1.5,
        step: 0.01,
        neutral: 1,
      },
      {
        kind: "slider",
        key: "frequency_penalty",
        label: "frequency_penalty",
        min: 0,
        max: 2,
        step: 0.05,
        neutral: 0,
      },
      {
        kind: "slider",
        key: "presence_penalty",
        label: "presence_penalty",
        min: 0,
        max: 2,
        step: 0.05,
        neutral: 0,
      },
      {
        kind: "slider",
        key: "penalty_range",
        label: "penalty_range",
        min: -1,
        max: 4096,
        step: 64,
        neutral: -1,
        info: "Tokens of context repetition penalty applies to. -1 means whole context.",
      },
      {
        kind: "number",
        key: "repetition_decay",
        label: "repetition_decay",
        min: 0,
        step: 1,
        neutral: 0,
      },
    ],
  },
  {
    id: "dynamic-temperature",
    title: "Dynamic temperature",
    // TabbyAPI has no dedicated "enable" flag; dynamic temp is effectively off
    // when min_temp == max_temp and both equal the static temperature.
    fields: [
      {
        kind: "slider",
        key: "min_temp",
        label: "min_temp",
        min: 0.01,
        max: 5,
        step: 0.01,
        neutral: 1,
      },
      {
        kind: "slider",
        key: "max_temp",
        label: "max_temp",
        min: 0.01,
        max: 5,
        step: 0.01,
        neutral: 1,
      },
      {
        kind: "slider",
        key: "temp_exponent",
        label: "temp_exponent",
        min: 0.01,
        max: 5,
        step: 0.01,
        neutral: 1,
      },
      {
        kind: "checkbox",
        key: "temperature_last",
        label: "temperature_last",
        neutral: false,
        info: "Apply temperature after all other samplers.",
      },
    ],
  },
  {
    id: "xtc",
    title: "XTC",
    fields: [
      {
        kind: "slider",
        key: "xtc_threshold",
        label: "xtc_threshold",
        min: 0,
        max: 0.5,
        step: 0.01,
        neutral: 0.1,
        info: "Probability floor for candidate tokens considered by XTC.",
      },
      {
        kind: "slider",
        key: "xtc_probability",
        label: "xtc_probability",
        min: 0,
        max: 1,
        step: 0.01,
        neutral: 0,
        info: "Chance per step that XTC fires. 0 disables.",
      },
    ],
  },
  {
    id: "mirostat",
    title: "Mirostat",
    fields: [
      {
        kind: "number",
        key: "mirostat_mode",
        label: "mirostat_mode",
        min: 0,
        max: 2,
        step: 1,
        neutral: 0,
        info: "0 disables Mirostat. TabbyAPI treats mode 2 as enabled for ExLlamaV2.",
      },
      {
        kind: "slider",
        key: "mirostat_tau",
        label: "mirostat_tau",
        min: 0,
        max: 10,
        step: 0.05,
        neutral: 1.5,
      },
      {
        kind: "slider",
        key: "mirostat_eta",
        label: "mirostat_eta",
        min: 0,
        max: 1,
        step: 0.01,
        neutral: 0.3,
      },
    ],
  },
  {
    id: "smoothing",
    title: "Smoothing",
    fields: [
      {
        kind: "slider",
        key: "smoothing_factor",
        label: "smoothing_factor",
        min: 0,
        max: 10,
        step: 0.01,
        neutral: 0,
        info: "Quadratic smoothing. 0 disables.",
      },
      {
        kind: "slider",
        key: "top_a",
        label: "top_a",
        min: 0,
        max: 1,
        step: 0.01,
        neutral: 0,
      },
      {
        kind: "slider",
        key: "typical_p",
        label: "typical_p",
        min: 0.01,
        max: 1,
        step: 0.01,
        neutral: 1,
        info: "TabbyAPI canonical name is typical; typical_p is accepted as an alias.",
      },
      {
        kind: "slider",
        key: "tfs",
        label: "tfs",
        min: 0,
        max: 1,
        step: 0.01,
        neutral: 1,
      },
    ],
  },
  {
    id: "misc",
    title: "Misc",
    fields: [
      {
        kind: "number",
        key: "min_tokens",
        label: "min_tokens",
        min: 0,
        step: 1,
        neutral: 0,
      },
    ],
  },
];

/** Flat list of every field (for quick lookups by key). */
export const SAMPLER_FIELDS: SamplerField[] = SAMPLER_SECTIONS.flatMap(
  (s) => s.fields,
);

const KNOWN_KEYS: Set<keyof SamplerBody> = new Set(
  SAMPLER_FIELDS.map((f) => f.key),
);

/** Neutral body — what "Neutralize Samplers" resets to. */
export function neutralBody(): SamplerBody {
  const body: SamplerBody = {};
  for (const field of SAMPLER_FIELDS) {
    // @ts-expect-error value matches its key's type by construction
    body[field.key] = field.neutral;
  }
  return body;
}

/**
 * Strip unknown keys and skip fields whose value equals the neutral default.
 * Sending every field on every request would stomp TabbyAPI's own defaults
 * for things we don't care about; sending only non-neutral fields keeps the
 * payload minimal and lets server-side defaults stand.
 */
export function sanitizeSamplerBody(body: SamplerBody): SamplerBody {
  const out: SamplerBody = {};
  for (const field of SAMPLER_FIELDS) {
    if (!(field.key in body)) continue;
    const value = body[field.key];
    if (value === undefined || value === null) continue;
    if (value === field.neutral) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    // @ts-expect-error value matches its key's type by construction
    out[field.key] = value;
  }
  return out;
}

/**
 * Merge an active preset's body with per-request overrides and strip to the
 * set of fields TabbyAPI actually accepts.
 */
export function mergePreset(
  preset: SamplerBody | null | undefined,
  overrides: SamplerBody = {},
): SamplerBody {
  const merged: SamplerBody = {};
  if (preset) {
    for (const [k, v] of Object.entries(preset)) {
      if (KNOWN_KEYS.has(k as keyof SamplerBody)) {
        // @ts-expect-error JSON shape verified at runtime
        merged[k] = v;
      }
    }
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (KNOWN_KEYS.has(k as keyof SamplerBody)) {
      // @ts-expect-error JSON shape verified at runtime
      merged[k] = v;
    }
  }
  return sanitizeSamplerBody(merged);
}
