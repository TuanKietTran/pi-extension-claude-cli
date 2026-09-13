/**
 * Claude CLI Provider Extension for pi
 *
 * Wraps the local `claude` binary as a pi provider. Auth comes from
 * whatever `claude` is already logged in as — no separate API key needed.
 *
 * Pi owns tool execution: Claude's native tools are disabled, active Pi tool
 * schemas are supplied through a structured-output bridge, and requested calls
 * are emitted as real pi ToolCall blocks. This preserves Pi's tool allowlists,
 * lifecycle events, validation, and result handling.
 */

import { spawn } from "child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { homedir } from "os";
import { join } from "path";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  ThinkingContent,
  Tool,
  ToolCall,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createClaudeStreamInput } from "./media.ts";

function resolveClaudeBin(): string {
  const candidates = [
    join(homedir(), ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return "claude"; // fall back to PATH lookup
}

const CLAUDE_BIN = resolveClaudeBin();

function contentText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((block: any) => block.type === "text" ? block.text : "[image]")
    .join("\n");
}

function formatMessage(message: Message): string {
  if (message.role === "user") return `Human: ${contentText(message.content)}`;

  if (message.role === "toolResult") {
    const status = message.isError ? "error" : "success";
    return `Tool result (${status}) for ${message.toolName} [${message.toolCallId}]:\n${contentText(message.content)}`;
  }

  const blocks = message.content.flatMap((block) => {
    if (block.type === "text") return block.text.trim() ? [block.text] : [];
    if (block.type === "toolCall") {
      return [`Tool call [${block.id}]: ${block.name}(${JSON.stringify(block.arguments)})`];
    }
    return [];
  });
  return `Assistant: ${blocks.join("\n")}`;
}

function buildHistory(messages: Message[]): string {
  return messages.map(formatMessage).filter((part) => part.trim()).join("\n\n");
}

function createOutputSchema(tools: Tool[]): Record<string, unknown> {
  const toolCallItems: Record<string, unknown> = {
    type: "object",
    properties: {
      name: tools.length > 0
        ? { type: "string", enum: tools.map((tool) => tool.name) }
        : { type: "string" },
      arguments: { type: "object" },
    },
    required: ["name", "arguments"],
    additionalProperties: false,
  };

  return {
    type: "object",
    properties: {
      text: { type: "string" },
      tool_calls: {
        type: "array",
        items: toolCallItems,
        ...(tools.length === 0 ? { maxItems: 0 } : {}),
      },
    },
    required: ["text", "tool_calls"],
    additionalProperties: false,
  };
}

function createToolBridgePrompt(tools: Tool[]): string {
  if (tools.length === 0) {
    return [
      "<pi_tool_bridge>",
      "No host tools are active. Return an empty tool_calls array and put the answer in text.",
      "</pi_tool_bridge>",
    ].join("\n");
  }

  const definitions = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));

  return [
    "<pi_tool_bridge>",
    "Claude's native tools are disabled. The following tools are provided by the Pi host.",
    "To call them, return each requested call in tool_calls. Pi executes them after this response and supplies the results in the next turn.",
    "Do not claim these host tools are unavailable. Do not simulate a tool call in prose.",
    "When one or more tools are needed, keep text brief and populate tool_calls with exact tool names and schema-valid arguments.",
    "When no tool is needed, return an empty tool_calls array and put the final answer in text.",
    JSON.stringify(definitions),
    "</pi_tool_bridge>",
  ].join("\n");
}

function parseStructuredOutput(value: unknown, tools: Tool[]): { text: string; toolCalls: ToolCall[] } {
  if (!value || typeof value !== "object") {
    throw new Error("claude CLI did not return structured output");
  }

  const candidate = value as { text?: unknown; tool_calls?: unknown };
  if (typeof candidate.text !== "string" || !Array.isArray(candidate.tool_calls)) {
    throw new Error("claude CLI returned invalid structured output");
  }

  const activeNames = new Set(tools.map((tool) => tool.name));
  const toolCalls = candidate.tool_calls.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`claude CLI returned an invalid tool call at index ${index}`);
    }
    const call = raw as { name?: unknown; arguments?: unknown };
    if (typeof call.name !== "string" || !activeNames.has(call.name)) {
      throw new Error(`claude CLI requested inactive tool: ${String(call.name)}`);
    }
    if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) {
      throw new Error(`claude CLI returned invalid arguments for tool: ${call.name}`);
    }
    return {
      type: "toolCall" as const,
      id: `claude_cli_${randomUUID()}`,
      name: call.name,
      arguments: call.arguments as Record<string, unknown>,
    };
  });

  return { text: candidate.text, toolCalls };
}

function streamClaudeCLI(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    };

    try {
      const tools = context.tools ?? [];
      const messages = context.messages;
      const lastMsg = messages[messages.length - 1];
      if (!lastMsg) throw new Error("claude CLI received an empty context");

      const prompt = formatMessage(lastMsg);
      const history = messages.slice(0, -1);
      const appendParts: string[] = [];
      if (context.systemPrompt) appendParts.push(context.systemPrompt);
      appendParts.push(createToolBridgePrompt(tools));
      if (history.length > 0) {
        appendParts.push(
          `<conversation_history>\n${buildHistory(history)}\n</conversation_history>`,
        );
      }

      const args = [
        "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--model", model.id,
        "--safe-mode",
        "--disable-slash-commands",
        "--strict-mcp-config",
        "--mcp-config", JSON.stringify({ mcpServers: {} }),
        "--tools", "",
        "--no-session-persistence",
        "--json-schema", JSON.stringify(createOutputSchema(tools)),
        "--append-system-prompt", appendParts.join("\n\n"),
      ];
      if (options?.reasoning) {
        args.push("--effort", options.reasoning === "minimal" ? "low" : options.reasoning);
      }

      const proc = spawn(CLAUDE_BIN, args, { env: { ...process.env } });
      proc.stdin.end(createClaudeStreamInput(lastMsg, prompt));

      stream.push({ type: "start", partial: output });

      type TrackedThinking = ThinkingContent & { _idx: number };
      const blocks: TrackedThinking[] = [];
      let structuredOutput: unknown;
      let resultError: string | undefined;
      let buf = "";
      let stderrBuf = "";

      proc.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: any;
          try { ev = JSON.parse(line); } catch { continue; }

          if (ev.type === "stream_event") {
            const e = ev.event;

            if (e.type === "message_start" && e.message?.usage) {
              const u = e.message.usage;
              output.usage.input = u.input_tokens ?? 0;
              output.usage.cacheRead = u.cache_read_input_tokens ?? 0;
              output.usage.cacheWrite = u.cache_creation_input_tokens ?? 0;

            } else if (e.type === "content_block_start" && e.content_block.type === "thinking") {
              const block = {
                type: "thinking" as const,
                thinking: "",
                thinkingSignature: "",
                _idx: e.index,
              } as TrackedThinking;
              output.content.push(block as any);
              blocks.push(block);
              stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });

            } else if (e.type === "content_block_delta") {
              const block = blocks.find((candidate) => candidate._idx === e.index);
              if (!block) continue;
              const contentIndex = output.content.indexOf(block as any);

              if (e.delta.type === "thinking_delta") {
                block.thinking += e.delta.thinking;
                stream.push({ type: "thinking_delta", contentIndex, delta: e.delta.thinking, partial: output });
              } else if (e.delta.type === "signature_delta") {
                block.thinkingSignature = (block.thinkingSignature ?? "") + e.delta.signature;
              }

            } else if (e.type === "content_block_stop") {
              const block = blocks.find((candidate) => candidate._idx === e.index);
              if (!block) continue;
              const contentIndex = output.content.indexOf(block as any);
              delete (block as any)._idx;
              stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });

            } else if (e.type === "message_delta" && e.usage) {
              output.usage.output = e.usage.output_tokens ?? 0;
              output.usage.totalTokens =
                output.usage.input + output.usage.output +
                output.usage.cacheRead + output.usage.cacheWrite;
            }

          } else if (ev.type === "result") {
            structuredOutput = ev.structured_output;
            if (ev.total_cost_usd != null) output.usage.cost.total = ev.total_cost_usd;
            if (ev.usage) {
              output.usage.input = ev.usage.input_tokens ?? output.usage.input;
              output.usage.output = ev.usage.output_tokens ?? output.usage.output;
              output.usage.cacheRead = ev.usage.cache_read_input_tokens ?? output.usage.cacheRead;
              output.usage.cacheWrite = ev.usage.cache_creation_input_tokens ?? output.usage.cacheWrite;
              output.usage.reasoning = ev.usage.output_tokens_details?.thinking_tokens;
              output.usage.totalTokens =
                output.usage.input + output.usage.output +
                output.usage.cacheRead + output.usage.cacheWrite;
            }
            if (ev.is_error || ev.subtype === "error") {
              resultError = ev.error ?? ev.result ?? "claude CLI error";
            }
          }
        }
      });

      proc.stderr.on("data", (c: Buffer) => { stderrBuf += c.toString(); });

      await new Promise<void>((resolve, reject) => {
        proc.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`claude exited ${code}: ${stderrBuf.slice(0, 500)}`));
        });
        proc.on("error", reject);
        options?.signal?.addEventListener("abort", () => proc.kill("SIGTERM"));
      });

      if (resultError) throw new Error(resultError);
      const result = parseStructuredOutput(structuredOutput, tools);

      if (result.text) {
        const contentIndex = output.content.length;
        output.content.push({ type: "text", text: result.text });
        stream.push({ type: "text_start", contentIndex, partial: output });
        stream.push({ type: "text_delta", contentIndex, delta: result.text, partial: output });
        stream.push({ type: "text_end", contentIndex, content: result.text, partial: output });
      }

      for (const call of result.toolCalls) {
        const contentIndex = output.content.length;
        const block: ToolCall = { ...call, arguments: {} };
        output.content.push(block);
        stream.push({ type: "toolcall_start", contentIndex, partial: output });
        const delta = JSON.stringify(call.arguments);
        stream.push({ type: "toolcall_delta", contentIndex, delta, partial: output });
        block.arguments = call.arguments;
        stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
      }

      output.stopReason = result.toolCalls.length > 0 ? "toolUse" : "stop";
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      for (const b of output.content) delete (b as any)._idx;
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

// Companion command for Claude's on-disk memory. Pi already provides native
// /compact and /resume commands, so this extension intentionally does not
// register conflicting aliases for them.
function registerCliCommands(pi: ExtensionAPI): void {
  // /memory — view/edit Claude's memory (CLAUDE.md). With text, quick-adds a
  // bullet to the project file (like Claude Code's `#` shortcut); with no args,
  // opens a chosen memory file in the editor and saves edits back.
  pi.registerCommand("memory", {
    description: "Add a memory line (/memory <text>) or edit CLAUDE.md memory files",
    handler: async (args, ctx) => {
      const projectMem = join(ctx.cwd, "CLAUDE.md");
      const userMem = join(homedir(), ".claude", "CLAUDE.md");

      const text = args.trim();
      if (text) {
        const bullet = text.startsWith("-") ? text : `- ${text}`;
        const header = existsSync(projectMem) ? "" : "# Project memory\n\n";
        appendFileSync(projectMem, `${header}${bullet}\n`);
        ctx.ui.notify(`Added to ${projectMem}`, "info");
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify("/memory needs an interactive session (or use /memory <text>)", "warning");
        return;
      }
      const target = await ctx.ui.select("Edit which memory file?", [
        `Project — ${projectMem}`,
        `User — ${userMem}`,
      ]);
      if (!target) return;
      const path = target.startsWith("Project") ? projectMem : userMem;
      const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
      const edited = await ctx.ui.editor(`Edit ${path}`, existing);
      if (edited == null || edited === existing) return;
      writeFileSync(path, edited);
      ctx.ui.notify(`Saved ${path}`, "info");
    },
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("claude-cli", {
    baseUrl: "https://api.anthropic.com",
    apiKey: "claude-cli",
    api: "claude-cli-api",

    models: [
      {
        id: "claude-fable-5",
        name: "Claude Fable 5 (CLI)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
      {
        id: "claude-opus-5",
        name: "Claude Opus 5 (CLI)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 128000,
      },
      {
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8 (CLI)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 32000,
      },
      {
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5 (CLI)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6 (CLI)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
      {
        id: "claude-haiku-4-5-20251001",
        name: "Claude Haiku 4.5 (CLI)",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
    ],

    streamSimple: streamClaudeCLI,
  });

  registerCliCommands(pi);
}
