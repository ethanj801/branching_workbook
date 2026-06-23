import type { TreeNode } from "../tree/types";
import type { ChatTurn, ChatTurnDraft } from "./turns";

// Mirror the labels the transcript shows above each turn so the exported
// file reads the same as the on-screen conversation.
const ROLE_LABELS: Record<ChatTurn["role"], string> = {
  system: "SYSTEM",
  user: "YOU",
  assistant: "ASSISTANT",
};

/**
 * Render the active-path conversation as a plain-text transcript: the system
 * prompt (if any) followed by each user/assistant turn, each block headed by
 * its role label. The system turn from `turns` is skipped because ChatSurface
 * renders the system prompt separately.
 */
function renderChatTranscript(
  systemText: string | null | undefined,
  turns: readonly ChatTurn[],
  turnText: (turn: ChatTurn) => string,
): string {
  const blocks: string[] = [];
  const trimmedSystemText = systemText?.trim();
  if (trimmedSystemText) {
    blocks.push(`${ROLE_LABELS.system}:\n${trimmedSystemText}`);
  }
  for (const turn of turns) {
    if (turn.role === "system") continue;
    blocks.push(`${ROLE_LABELS[turn.role]}:\n${turnText(turn).trim()}`);
  }
  return `${blocks.join("\n\n")}\n`;
}

export function buildChatTranscript(
  systemNode: TreeNode | null,
  turns: readonly ChatTurn[],
): string {
  return renderChatTranscript(systemNode?.text, turns, (turn) => turn.text);
}

export function buildChatTranscriptWithDrafts(
  systemDraft: string,
  turns: readonly ChatTurn[],
  turnDrafts: Readonly<Record<string, ChatTurnDraft>>,
): string {
  return renderChatTranscript(systemDraft, turns, (turn) => {
    const firstNodeId = turn.nodes[0]?.id;
    if (!firstNodeId) return turn.text;
    return turnDrafts[firstNodeId]?.text ?? turn.text;
  });
}

// Turn a project title into a safe .txt filename, falling back to "chat" when
// the workbook is untitled.
export function chatTranscriptFilename(title: string | null): string {
  const safe = (title ?? "")
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${safe || "chat"}.txt`;
}

// Trigger a browser download of `text` as a file. Standard Blob + anchor
// dance; revokes the object URL once the click is dispatched.
export function downloadTextFile(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
