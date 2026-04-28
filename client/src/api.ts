import type { NodeSource } from "./tree/types";

export type CompletionChoice = {
  index: number;
  text: string;
  finish_reason: string | null;
};

export type CompletionChunk = {
  id: string;
  object: string;
  created: number;
  model?: string;
  model_name?: string;
  choices: CompletionChoice[];
};

// Superset of the TabbyAPI fields we'll ever send in one request.
// The client builds this by merging `{ prompt, n }` with the active sampler
// preset (filtered to known-supported keys by `sanitizeSamplerBody`).
export type CompletionRequestBody = {
  prompt: string;
  n?: number;
  max_tokens?: number;
  min_tokens?: number;
  temperature?: number;
  temperature_last?: boolean;
  top_p?: number;
  top_k?: number;
  top_a?: number;
  min_p?: number;
  tfs?: number;
  typical?: number;
  typical_p?: number;
  xtc_threshold?: number;
  xtc_probability?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  penalty_range?: number;
  repetition_decay?: number;
  smoothing_factor?: number;
  dry_multiplier?: number;
  dry_base?: number;
  dry_allowed_length?: number;
  dry_range?: number;
  dry_sequence_breakers?: string | string[];
  mirostat_mode?: number;
  mirostat_tau?: number;
  mirostat_eta?: number;
  min_temp?: number;
  max_temp?: number;
  temp_exponent?: number;
  stop?: string[];
  ban_eos_token?: boolean;
};

export type SamplerBody = Omit<CompletionRequestBody, "prompt" | "n">;

export type SamplerPreset = {
  id: string;
  name: string;
  body: SamplerBody;
  is_starter: boolean;
  created_at: string;
  updated_at: string;
};

export type ActivePreset = {
  preset_id: string | null;
};

export type ProjectInfo = {
  path: string;
  title: string | null;
  created_at: string | null;
  version: string;
};

export type ComposeDisplayMode = "cards" | "inline";

export type ProjectSettings = {
  display_mode: ComposeDisplayMode;
  branch_count: number;
  max_tokens: number;
  tokens_per_suggestion: number;
};

export type ProjectSettingsPatch = Partial<ProjectSettings>;

export type NodeModel = {
  id: string;
  parent_id: string | null;
  text: string;
  name?: string | null;
  source: NodeSource;
  hidden: boolean;
  is_main_path: boolean;
  starred?: boolean;
  created_at: number;
  prior_context_hash: string;
  sampler_snapshot?: unknown | null;
  seed?: number | null;
  model_identifier?: string | null;
};

export type MutationBatch = {
  creates?: NodeModel[];
  updates?: NodeModel[];
  deletes?: string[];
  main_path?: string[] | null;
};

export type TabbyModelParameters = {
  max_seq_len?: number | null;
  cache_size?: number | null;
  cache_mode?: string | null;
  rope_scale?: number | null;
  rope_alpha?: number | null;
  max_batch_size?: number | null;
  chunk_size?: number | null;
  prompt_template?: string | null;
  prompt_template_content?: string | null;
  use_vision?: boolean | null;
  draft?: TabbyModel | null;
};

export type TabbyModel = {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  logging?: unknown | null;
  parameters?: TabbyModelParameters | null;
};

export type TabbyModelList = {
  object: "list";
  data: TabbyModel[];
};

export type ModelLoadRequest = {
  model_name: string;
  max_seq_len?: number;
  cache_size?: number;
  cache_mode?: string;
  tensor_parallel?: boolean;
};

export type ModelLoadEvent = {
  model_type: string;
  module: number;
  modules: number;
  status: string;
};

export type ModelDownloadRequest = {
  repo_id: string;
  revision?: string;
  folder_name?: string;
};

export type ModelDownloadResponse = {
  download_path: string;
};

export type TokenEncodeResponse = {
  tokens: number[];
  length: number;
};

async function requestJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    let message = `${init?.method ?? "GET"} ${path} failed: ${response.status}`;
    try {
      const payload = (await response.json()) as { detail?: unknown };
      if (typeof payload.detail === "string") message = payload.detail;
    } catch {
      // Keep the status-based message if the response is not JSON.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

async function streamRequestError(response: Response): Promise<Error> {
  let message = `stream request failed: ${response.status}`;
  try {
    const payload = (await response.json()) as { detail?: unknown; error?: unknown };
    const detail = payload.detail ?? payload.error;
    if (typeof detail === "string") message = detail;
  } catch {
    // Keep the status-based message if the response is not JSON.
  }
  return new Error(message);
}

function streamErrorMessage(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const maybeError = payload as { error?: unknown; detail?: unknown };
  const message = maybeError.error ?? maybeError.detail;
  return typeof message === "string" ? message : null;
}

export function createProject(
  path: string,
  title?: string,
): Promise<ProjectInfo> {
  return requestJson<ProjectInfo>("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, title: title || null }),
  });
}

export function openProject(path: string): Promise<ProjectInfo> {
  return requestJson<ProjectInfo>("/api/projects/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

export function closeProject(): Promise<{ closed: boolean }> {
  return requestJson<{ closed: boolean }>("/api/projects/close", {
    method: "POST",
  });
}

export function currentProject(): Promise<ProjectInfo | null> {
  return requestJson<ProjectInfo | null>("/api/projects/current");
}

export function getProjectSettings(): Promise<ProjectSettings> {
  return requestJson<ProjectSettings>("/api/project/settings");
}

export function updateProjectSettings(
  patch: ProjectSettingsPatch,
): Promise<ProjectSettings> {
  return requestJson<ProjectSettings>("/api/project/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

// Native OS file dialog endpoints. The browser cannot show a real
// filesystem picker, so the local FastAPI wrapper drives one via
// AppleScript and hands back the chosen path. The path is never logged
// or persisted — it is the response body and nothing more. A null path
// means the user cancelled the dialog.
export type DialogPath = { path: string | null };

export function dialogPickProject(): Promise<DialogPath> {
  return requestJson<DialogPath>("/api/projects/dialog/open", {
    method: "POST",
  });
}

export function dialogPickNewProject(): Promise<DialogPath> {
  return requestJson<DialogPath>("/api/projects/dialog/create", {
    method: "POST",
  });
}

export function listNodes(): Promise<NodeModel[]> {
  return requestJson<NodeModel[]>("/api/nodes");
}

export function mutateNodes(batch: MutationBatch): Promise<{
  created: number;
  updated: number;
  deleted: number;
}> {
  return requestJson("/api/nodes/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(batch),
  });
}

async function streamJsonEvents<T>(
  response: Response,
  onEvent: (event: T) => void,
): Promise<void> {
  if (!response.ok || !response.body) {
    throw await streamRequestError(response);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frameSep = /\r?\n\r?\n/;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const match = frameSep.exec(buffer);
      if (!match) break;
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);

      const dataPayload = frame
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => (l.startsWith("data: ") ? l.slice(6) : l.slice(5)))
        .join("\n");

      if (!dataPayload) continue;
      if (dataPayload === "[DONE]") return;

      let payload: unknown;
      try {
        payload = JSON.parse(dataPayload);
      } catch {
        // malformed frame — ignore
        continue;
      }
      const errorMessage = streamErrorMessage(payload);
      if (errorMessage) throw new Error(errorMessage);
      onEvent(payload as T);
    }
  }
}

export async function streamCompletion(
  body: CompletionRequestBody,
  onChunk: (chunk: CompletionChunk) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });

  await streamJsonEvents(response, onChunk);
}

export function currentModel(): Promise<TabbyModel | null> {
  return requestJson<TabbyModel | null>("/api/tabby/model");
}

export function listModels(): Promise<TabbyModelList> {
  return requestJson<TabbyModelList>("/api/tabby/models");
}

export async function streamModelLoad(
  body: ModelLoadRequest,
  onEvent: (event: ModelLoadEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/tabby/model/load", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  await streamJsonEvents(response, onEvent);
}

export function unloadModel(): Promise<{ unloaded: boolean }> {
  return requestJson<{ unloaded: boolean }>("/api/tabby/model/unload", {
    method: "POST",
  });
}

export function downloadModel(
  body: ModelDownloadRequest,
): Promise<ModelDownloadResponse> {
  return requestJson<ModelDownloadResponse>("/api/tabby/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function encodeTokens(text: string): Promise<TokenEncodeResponse> {
  return requestJson<TokenEncodeResponse>("/api/tabby/token/encode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

export function listPresets(): Promise<SamplerPreset[]> {
  return requestJson<SamplerPreset[]>("/api/samplers/presets");
}

export function createPreset(
  name: string,
  body: SamplerBody,
): Promise<SamplerPreset> {
  return requestJson<SamplerPreset>("/api/samplers/presets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, body }),
  });
}

export function updatePreset(
  presetId: string,
  patch: { name?: string; body?: SamplerBody },
): Promise<SamplerPreset> {
  return requestJson<SamplerPreset>(`/api/samplers/presets/${presetId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export function deletePreset(presetId: string): Promise<{ deleted: boolean }> {
  return requestJson<{ deleted: boolean }>(
    `/api/samplers/presets/${presetId}`,
    { method: "DELETE" },
  );
}

export function getActivePreset(): Promise<ActivePreset> {
  return requestJson<ActivePreset>("/api/samplers/active");
}

export function setActivePreset(presetId: string | null): Promise<ActivePreset> {
  return requestJson<ActivePreset>("/api/samplers/active", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ preset_id: presetId }),
  });
}
