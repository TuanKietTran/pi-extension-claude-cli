import type { Message } from "@earendil-works/pi-ai";

type ClaudeInputBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    };

/** Build one Claude Code stream-json user event, preserving Pi image blocks. */
export function createClaudeStreamInput(message: Message, prompt: string): string {
  const content: ClaudeInputBlock[] = [{ type: "text", text: prompt }];

  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type !== "image") continue;
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: block.mimeType,
          data: block.data,
        },
      });
    }
  }

  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content },
  })}\n`;
}
