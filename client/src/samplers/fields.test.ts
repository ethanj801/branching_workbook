import { describe, expect, it } from "vitest";

import type { SamplerBody } from "../api";
import {
  SAMPLER_FIELDS,
  mergePreset,
  neutralBody,
  sanitizeSamplerBody,
} from "./fields";

describe("neutralBody", () => {
  it("includes every catalog field with its neutral value", () => {
    const body = neutralBody();
    for (const field of SAMPLER_FIELDS) {
      expect(body[field.key], `neutral for ${field.key}`).toEqual(field.neutral);
    }
  });
});

describe("sanitizeSamplerBody", () => {
  it("drops fields equal to their neutral default", () => {
    const body: SamplerBody = {
      temperature: 1, // neutral
      min_p: 0.02, // non-neutral
      top_p: 1, // neutral
    };
    expect(sanitizeSamplerBody(body)).toEqual({ min_p: 0.02 });
  });

  it("drops empty string fields (text inputs)", () => {
    const body: SamplerBody = { dry_sequence_breakers: "  " };
    expect(sanitizeSamplerBody(body)).toEqual({});
  });

  it("strips unknown keys that leaked in from a forward-compat preset", () => {
    // @ts-expect-error deliberately passing an unknown key
    const body: SamplerBody = { temperature: 1.2, future_param: 99 };
    const cleaned = sanitizeSamplerBody(body) as Record<string, unknown>;
    expect(cleaned).toEqual({ temperature: 1.2 });
    expect("future_param" in cleaned).toBe(false);
  });

  it("keeps false for checkbox fields only when it differs from neutral", () => {
    // temperature_last neutral is false, so false should drop out
    const body: SamplerBody = { temperature_last: false };
    expect(sanitizeSamplerBody(body)).toEqual({});
    const enabled: SamplerBody = { temperature_last: true };
    expect(sanitizeSamplerBody(enabled)).toEqual({ temperature_last: true });
  });

  it("drops empty list fields and blank lines within them", () => {
    expect(sanitizeSamplerBody({ dry_sequence_breakers: [] })).toEqual({});
    expect(sanitizeSamplerBody({ dry_sequence_breakers: ["", ""] })).toEqual({});
    expect(sanitizeSamplerBody({ dry_sequence_breakers: ["foo", "", "bar"] })).toEqual({
      dry_sequence_breakers: ["foo", "bar"],
    });
  });

  it("preserves whitespace inside a list entry", () => {
    // A space-bearing entry is intentional and must survive verbatim.
    expect(sanitizeSamplerBody({ dry_sequence_breakers: [" the "] })).toEqual({
      dry_sequence_breakers: [" the "],
    });
  });

  it("turns a typed backslash escape into the real control character", () => {
    // "\\n" is the two characters backslash and n. It must reach TabbyAPI as a
    // single newline so the break actually fires on line ends.
    expect(sanitizeSamplerBody({ dry_sequence_breakers: ["\\n", "."] })).toEqual({
      dry_sequence_breakers: ["\n", "."],
    });
  });

  it("coerces a stray string list value to a single entry", () => {
    expect(sanitizeSamplerBody({ dry_sequence_breakers: "." })).toEqual({
      dry_sequence_breakers: ["."],
    });
  });
});

describe("mergePreset", () => {
  it("returns empty when preset is null and no overrides", () => {
    expect(mergePreset(null)).toEqual({});
  });

  it("applies preset fields then overrides on top", () => {
    const preset: SamplerBody = { temperature: 1.2, min_p: 0.02, top_p: 0.95 };
    const overrides: SamplerBody = { temperature: 0.8 };
    expect(mergePreset(preset, overrides)).toEqual({
      temperature: 0.8,
      min_p: 0.02,
      top_p: 0.95,
    });
  });

  it("sanitizes unknown keys from the preset body", () => {
    const preset = { temperature: 1.1, nonsense: "x" } as SamplerBody;
    expect(mergePreset(preset)).toEqual({ temperature: 1.1 });
  });

  it("strips neutral-valued fields from the merged result", () => {
    const preset: SamplerBody = { temperature: 1, min_p: 0.05 };
    expect(mergePreset(preset)).toEqual({ min_p: 0.05 });
  });

  it("overrides can re-neutralize a preset field (drop it from payload)", () => {
    const preset: SamplerBody = { min_p: 0.05 };
    const overrides: SamplerBody = { min_p: 0 };
    expect(mergePreset(preset, overrides)).toEqual({});
  });
});
