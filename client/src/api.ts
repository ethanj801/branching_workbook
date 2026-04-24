export type CompletionChoice = {
  index: number;
  text: string;
  finish_reason: string | null;
};

export type CompletionChunk = {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: CompletionChoice[];
};

export type CompletionRequestBody = {
  prompt: string;
  n?: number;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
};

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

  if (!response.ok || !response.body) {
    throw new Error(`completion request failed: ${response.status}`);
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

      try {
        const chunk = JSON.parse(dataPayload) as CompletionChunk;
        onChunk(chunk);
      } catch {
        // malformed frame — ignore
      }
    }
  }
}
