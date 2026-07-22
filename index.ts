/**
 * Claude CLI Provider Extension for pi
 *
 * Wraps the local `claude` binary as a pi provider. Auth comes from
 * whatever `claude` is already logged in as — no separate API key needed.
 *
 * Fixes vs original:
 *  - Removed --tools "" (was causing hallucinated fake tool calls in text)
 *  - Changed --system-prompt to --append-system-prompt (preserves claude's
 *    default system prompt + tool descriptions)
 *  - Added --add-dir so claude can access the working directory
 *  - tool_use blocks are now rendered as visible ▶ Tool lines in the stream
 */

import { spawn } from "child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
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
  TextContent,
  ThinkingContent,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CLAUDE_BIN = "/opt/homebrew/bin/claude";

// Appended to the system prompt only when a browser server is attached.
// Drives the token-efficient, "humanized tester" behavior both browser MCPs
// make possible: semantic accessibility snapshots + stable element refs/uids
// instead of expensive screenshots and pixel-guessing. Engine-neutral — the
// chrome-devtools and firefox-devtools servers share the same tool concepts
// (take_snapshot, click/fill by ref, evaluate_script, console/network lists).
// See README for the why/measurements.
function browserSystemPrompt(engineLabel: string): string {
  return `You are driving a REAL browser — ${engineLabel} — through its accessibility-snapshot MCP tools. Work token-efficiently and behave like a careful human tester.

STARTUP
- The browser server can take 10-30s to become ready on first use (it launches a real browser). If a browser tool isn't available yet or returns a "still connecting"/not-ready error, WAIT briefly and retry the SAME browser tool. Do NOT fall back to WebFetch/Bash to fetch the page — those defeat the purpose; the task requires the live browser.

OBSERVE
- Default to take_snapshot: the accessibility tree with stable element refs/uids. It is ~10-20x cheaper than a screenshot and the refs are what you act on.
- Do NOT re-snapshot a page that has not changed. Reuse the refs you already have; snapshot again only after a navigation or a DOM-changing action.
- To read specific data (text, values, attributes, computed styles, counts), call evaluate_script with a tiny JS expression that returns ONLY the value you need. Never screenshot just to "read" a page.
- Use the console and network listing tools to catch errors instead of inferring them visually.

ACT
- Interact by ref/uid (click / fill / hover the element from the latest snapshot). Never guess pixel coordinates.
- After an action, wait for navigation/network to settle before the next snapshot.
- Move like a human: one logical step at a time, fill forms field-by-field, follow visible affordances, don't hammer the same control.

SCREENSHOT — sparingly
- Take a screenshot ONLY when the task is inherently visual: layout/CSS/rendering bugs, canvas/WebGL/image content, or when the accessibility tree is missing or insufficient. Otherwise prefer snapshot + evaluate_script.

REPORTING (for smoke / regression / bug-bounty work)
- Smoke & regression: navigate, assert key elements exist via snapshot, check console + network for errors, return a clear PASS/FAIL with the evidence (ref, value, console line, or failed request).
- UI / visual bug bounty: cross-check snapshot semantics against the rendered screenshot; flag mismatches, overlapping or cut-off elements, broken/empty states, console errors, and failed requests.
- Always be concise: what you did, what you observed (with concrete evidence), and the verdict.`;
}

// Resolve a Gecko (Firefox/Zen) binary for the firefox-devtools MCP. Honors an
// explicit override, else probes the common macOS install locations — Zen first
// since that's a Firefox fork the user runs.
function resolveFirefoxPath(): string | undefined {
  if (process.env.CLAUDE_CLI_FIREFOX_PATH) return process.env.CLAUDE_CLI_FIREFOX_PATH;
  const home = process.env.HOME ?? "";
  const candidates = [
    "/Applications/Zen.app/Contents/MacOS/zen",
    `${home}/Applications/Zen.app/Contents/MacOS/zen`,
    "/Applications/Firefox.app/Contents/MacOS/firefox",
    "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox",
    "/Applications/Firefox Nightly.app/Contents/MacOS/firefox",
  ];
  return candidates.find((p) => existsSync(p));
}

function buildHistory(messages: Message[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : (msg.content as any[])
              .map((c) => (c.type === "text" ? c.text : "[image]"))
              .join("\n");
      parts.push(`Human: ${text}`);
    } else if (msg.role === "assistant") {
      const text = (msg.content as any[])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      if (text.trim()) parts.push(`Assistant: ${text}`);
    }
  }
  return parts.join("\n\n");
}

function formatToolCall(name: string, inputJson: string): string {
  try {
    const input = JSON.parse(inputJson || "{}");
    if (name === "Bash" && input.command) {
      return `▶ Bash: \`${input.command}\`\n\n`;
    }
    if ((name === "Read" || name === "Write" || name === "Edit") && input.file_path) {
      return `▶ ${name}: ${input.file_path}\n\n`;
    }
    if (name === "Glob" && input.pattern) {
      return `▶ Glob: ${input.pattern}\n\n`;
    }
    if (name === "WebFetch" && input.url) {
      return `▶ WebFetch: ${input.url}\n\n`;
    }
    if (name === "WebSearch" && input.query) {
      return `▶ WebSearch: ${input.query}\n\n`;
    }
    if (name === "ToolSearch" && input.query) {
      return `▶ ToolSearch: ${input.query}\n\n`;
    }
    // MCP tools (e.g. browser via chrome-devtools): "mcp__<server>__<tool>"
    if (name.startsWith("mcp__")) {
      const parts = name.slice(5).split("__");
      const tool = parts.slice(1).join("__") || parts[0];
      const arg = Object.values(input)[0];
      const detail = arg != null ? `: ${String(arg).slice(0, 120)}` : "";
      return `▶ ${tool}${detail}\n\n`;
    }
    // Fallback: show first param
    const first = Object.entries(input)[0];
    if (first) return `▶ ${name}: ${String(first[1]).slice(0, 120)}\n\n`;
    return `▶ ${name}\n\n`;
  } catch {
    return `▶ ${name}\n\n`;
  }
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
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      const messages = context.messages;
      const lastMsg = messages[messages.length - 1];
      const history = messages.slice(0, -1);

      const prompt =
        typeof lastMsg.content === "string"
          ? lastMsg.content
          : (lastMsg.content as any[])
              .map((c) => (c.type === "text" ? c.text : "[image]"))
              .join("\n");

      // Use --append-system-prompt so we add to claude's default system prompt
      // (tool descriptions, CLAUDE.md discovery) rather than replacing it
      const appendParts: string[] = [];
      if (context.systemPrompt) appendParts.push(context.systemPrompt);
      if (history.length > 0) {
        appendParts.push(
          `<conversation_history>\n${buildHistory(history)}\n</conversation_history>`,
        );
      }

      const cwd = process.cwd();
      const args = [
        "-p", prompt,
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--model", model.id,
        "--add-dir", cwd,
        // NOTE: --tools "" removed — was causing claude to hallucinate fake
        // tool calls as text since it expected tools but had none available
      ];

      // Child env; browser block may raise the MCP startup timeout below.
      const childEnv: NodeJS.ProcessEnv = { ...process.env };

      // Tools that must be explicitly granted in -p (print) mode. Bash/Read/
      // Edit/etc. are already permitted by the user's local claude settings;
      // these server-side web tools are denied unless allowed here (there's no
      // interactive prompt to grant them). Pushed as ONE comma-separated flag —
      // a repeated --allowedTools could override rather than merge.
      const allowedTools = ["WebSearch", "WebFetch"];

      // Opt-in browser interaction. Set CLAUDE_CLI_BROWSER=1 to attach a browser
      // MCP server that drives a REAL browser via accessibility snapshots — far
      // more token-efficient than playwright/full-DOM tools (snapshot ~200-400
      // tok vs screenshot ~4-5k) because browserSystemPrompt biases the model to
      // semantic snapshots + ref-based actions. Two engines, same token model:
      //   chrome  -> chrome-devtools-mcp over CDP (Chrome / Chromium)
      //   firefox -> @mozilla/firefox-devtools-mcp over WebDriver BiDi/Marionette
      //              (Firefox AND Gecko forks like Zen)
      // Pick via CLAUDE_CLI_BROWSER_ENGINE=chrome|firefox (aliases: zen, gecko,
      // mozilla, ff -> firefox; chromium -> chrome). If unset, auto-detects
      // firefox when a Zen/Firefox binary is present and no CDP url is given,
      // else chrome. Off by default so ordinary prompts don't spawn a browser.
      // Done before the system prompt is consumed below so guidance is included.
      if (process.env.CLAUDE_CLI_BROWSER) {
        let engine = (process.env.CLAUDE_CLI_BROWSER_ENGINE ?? "").toLowerCase();
        if (["zen", "gecko", "mozilla", "ff", "firefox"].includes(engine)) engine = "firefox";
        if (["chrome", "chromium"].includes(engine)) engine = "chrome";
        const firefoxPath = resolveFirefoxPath();
        if (!engine) {
          // A CDP url implies Chrome; otherwise prefer an installed Gecko.
          engine = process.env.CLAUDE_CLI_BROWSER_URL ? "chrome" : firefoxPath ? "firefox" : "chrome";
        }

        let mcpConfig: string;
        let allowTool: string;
        let engineLabel: string;

        if (process.env.CLAUDE_CLI_BROWSER_CONFIG) {
          // User-supplied config (full override). Allow the matching wildcard.
          mcpConfig = process.env.CLAUDE_CLI_BROWSER_CONFIG;
          allowTool = engine === "firefox" ? "mcp__firefox-devtools" : "mcp__chrome-devtools";
          engineLabel = engine === "firefox" ? "Firefox/Zen (Gecko)" : "Chrome";
        } else if (engine === "firefox") {
          const ffArgs = [
            "-y", "@mozilla/firefox-devtools-mcp@latest",
            // evaluate_script is gated behind this flag (Firefox 153+); we depend
            // on it for cheap data extraction instead of screenshots. On older
            // Gecko it's simply a no-op — the model falls back to snapshots.
            "--enableScript",
          ];
          if (firefoxPath) ffArgs.push("--firefoxPath", firefoxPath);
          // Reuse the user's logged-in profile for a "humanized" session.
          if (process.env.CLAUDE_CLI_BROWSER_PROFILE)
            ffArgs.push("--profilePath", process.env.CLAUDE_CLI_BROWSER_PROFILE);
          // Attach to an already-running Firefox/Zen launched with `--marionette`
          // instead of spawning one. Note: BiDi-only features (console/network
          // events) are unavailable in connect-existing mode.
          if (process.env.CLAUDE_CLI_BROWSER_CONNECT) {
            ffArgs.push("--connectExisting");
            if (process.env.CLAUDE_CLI_MARIONETTE_PORT)
              ffArgs.push("--marionettePort", process.env.CLAUDE_CLI_MARIONETTE_PORT);
          } else {
            // Only when WE launch the browser: suppress the first-run / welcome /
            // "what's new" tabs. On a fresh (or freshly-updated) Gecko profile
            // these open an extra onboarding tab that pollutes the first snapshot
            // and can intercept the first navigation/click. Gecko has no
            // --no-first-run CLI flag, so we set the equivalent prefs via
            // moz:firefoxOptions (--pref). Applied per-launch; the user's real
            // profile is untouched. Extra prefs can be appended (newline- or
            // comma-separated name=value) via CLAUDE_CLI_BROWSER_PREFS.
            const prefs = [
              "browser.aboutwelcome.enabled=false",
              "browser.startup.homepage_override.mstone=ignore",
              "browser.messaging-system.whatsNewPanel.enabled=false",
              "startup.homepage_welcome_url=about:blank",
              "startup.homepage_welcome_url.additional=about:blank",
              "trailhead.firstrun.didSeeAboutWelcome=true",
              "datareporting.policy.firstRunURL=",
            ];
            if (process.env.CLAUDE_CLI_BROWSER_PREFS)
              prefs.push(...process.env.CLAUDE_CLI_BROWSER_PREFS.split(/[\n,]+/));
            for (const p of prefs) {
              const pref = p.trim();
              if (pref) ffArgs.push("--pref", pref);
            }
          }
          mcpConfig = JSON.stringify({
            mcpServers: { "firefox-devtools": { command: "npx", args: ffArgs } },
          });
          allowTool = "mcp__firefox-devtools";
          engineLabel = firefoxPath?.includes("zen") ? "Zen (Firefox/Gecko)" : "Firefox (Gecko)";
        } else {
          const cdpArgs = [
            "-y", "chrome-devtools-mcp@latest",
            // Make the *rare* screenshot cheap: webp is ~3-5x smaller than png.
            "--screenshotFormat", "webp",
            "--screenshotQuality", "60",
            "--screenshotMaxWidth", "1280",
          ];
          // Attach to an already-running Chrome (real session, logins, cookies)
          // when CLAUDE_CLI_BROWSER_URL points at a remote-debugging endpoint,
          // e.g. http://127.0.0.1:9222 — start Chrome with
          // --remote-debugging-port=9222. Otherwise a dedicated (non-headless,
          // still real) Chrome profile is launched automatically.
          if (process.env.CLAUDE_CLI_BROWSER_URL)
            cdpArgs.push("--browserUrl", process.env.CLAUDE_CLI_BROWSER_URL);
          mcpConfig = JSON.stringify({
            mcpServers: { "chrome-devtools": { command: "npx", args: cdpArgs } },
          });
          allowTool = "mcp__chrome-devtools";
          engineLabel = "Chrome";
        }

        // --mcp-config accepts a JSON string, not just a file path.
        args.push("--mcp-config", mcpConfig);
        // Allow every tool from the browser server (mcp__<server> wildcard).
        allowedTools.push(allowTool);
        appendParts.push(browserSystemPrompt(engineLabel));
        // Cold start launches a real browser (~10-30s for Zen/Firefox); the
        // default MCP startup timeout can mark the server failed before it's
        // ready. Give it room (honored by claude as MCP_TIMEOUT, in ms).
        if (!childEnv.MCP_TIMEOUT) childEnv.MCP_TIMEOUT = "60000";
      }

      if (appendParts.length > 0) {
        args.push("--append-system-prompt", appendParts.join("\n\n"));
      }

      args.push("--allowedTools", allowedTools.join(","));

      const proc = spawn(CLAUDE_BIN, args, { env: childEnv });

      stream.push({ type: "start", partial: output });

      // Internal block tracking — tool_use blocks are tracked but stored as
      // TextContent so we can render them as visible ▶ lines in the pi stream
      type TrackedBlock = (ThinkingContent | TextContent) & {
        _idx: number;
        _isToolCall?: boolean;
        _toolName?: string;
        _inputJson?: string;
      };
      const blocks: TrackedBlock[] = [];

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

            } else if (e.type === "content_block_start") {
              if (e.content_block.type === "text") {
                const block = { type: "text" as const, text: "", _idx: e.index } as TrackedBlock;
                output.content.push(block as any);
                blocks.push(block);
                stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });

              } else if (e.content_block.type === "thinking") {
                const block = {
                  type: "thinking" as const,
                  thinking: "",
                  thinkingSignature: "",
                  _idx: e.index,
                } as TrackedBlock;
                output.content.push(block as any);
                blocks.push(block);
                stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });

              } else if (e.content_block.type === "tool_use") {
                // Stored as a text block; rendered as "▶ ToolName: ..." once input is complete
                const block = {
                  type: "text" as const,
                  text: "",
                  _idx: e.index,
                  _isToolCall: true,
                  _toolName: e.content_block.name,
                  _inputJson: "",
                } as TrackedBlock;
                output.content.push(block as any);
                blocks.push(block);
                // defer text_start until we have the full input to format
              }

            } else if (e.type === "content_block_delta") {
              const bi = blocks.findIndex((b) => b._idx === e.index);
              if (bi === -1) continue;
              const block = blocks[bi];
              const ci = output.content.indexOf(block as any);

              if (e.delta.type === "text_delta" && block.type === "text" && !block._isToolCall) {
                (block as any).text += e.delta.text;
                stream.push({ type: "text_delta", contentIndex: ci, delta: e.delta.text, partial: output });

              } else if (e.delta.type === "thinking_delta" && block.type === "thinking") {
                (block as any).thinking += e.delta.thinking;
                stream.push({ type: "thinking_delta", contentIndex: ci, delta: e.delta.thinking, partial: output });

              } else if (e.delta.type === "signature_delta" && block.type === "thinking") {
                (block as any).thinkingSignature =
                  ((block as any).thinkingSignature ?? "") + e.delta.signature;

              } else if (e.delta.type === "input_json_delta" && block._isToolCall) {
                block._inputJson = (block._inputJson ?? "") + e.delta.partial_json;
              }

            } else if (e.type === "content_block_stop") {
              const bi = blocks.findIndex((b) => b._idx === e.index);
              if (bi === -1) continue;
              const block = blocks[bi];
              const ci = output.content.indexOf(block as any);
              delete (block as any)._idx;

              if (block._isToolCall) {
                const formatted = formatToolCall(
                  block._toolName ?? "tool",
                  block._inputJson ?? "",
                );
                (block as any).text = formatted;
                // Emit start → delta → end now that we have the full formatted line
                stream.push({ type: "text_start", contentIndex: ci, partial: output });
                stream.push({ type: "text_delta", contentIndex: ci, delta: formatted, partial: output });
                stream.push({ type: "text_end", contentIndex: ci, content: formatted, partial: output });
                delete (block as any)._isToolCall;
                delete (block as any)._toolName;
                delete (block as any)._inputJson;

              } else if (block.type === "text") {
                stream.push({ type: "text_end", contentIndex: ci, content: (block as any).text, partial: output });
              } else if (block.type === "thinking") {
                stream.push({ type: "thinking_end", contentIndex: ci, content: (block as any).thinking, partial: output });
              }

            } else if (e.type === "message_delta" && e.usage) {
              output.usage.output = e.usage.output_tokens ?? 0;
              output.usage.totalTokens =
                output.usage.input + output.usage.output +
                output.usage.cacheRead + output.usage.cacheWrite;
            }

          } else if (ev.type === "result") {
            if (ev.total_cost_usd != null) output.usage.cost.total = ev.total_cost_usd;
            if (ev.subtype === "error") throw new Error(ev.error ?? "claude CLI error");
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

      for (const b of output.content) {
        delete (b as any)._idx;
        delete (b as any)._isToolCall;
        delete (b as any)._toolName;
        delete (b as any)._inputJson;
      }

      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      for (const b of output.content) {
        delete (b as any)._idx;
        delete (b as any)._isToolCall;
        delete (b as any)._toolName;
        delete (b as any)._inputJson;
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

// Basic companion commands mirroring Claude Code's own /compact, /resume and
// /memory, adapted to this wrapper. This provider spawns `claude -p` fresh each
// turn (no persistent claude session), so these operate on pi's session and on
// Claude's on-disk memory (CLAUDE.md) rather than a live claude session id.
function registerCliCommands(pi: ExtensionAPI): void {
  // /compact — summarize the conversation to reclaim context. Optional args are
  // passed as focus instructions to the summarizer. Delegates to pi's own
  // compaction (which shrinks the history this provider replays each turn).
  pi.registerCommand("compact", {
    description: "Compact the conversation to free context (optional: /compact <focus>)",
    handler: async (args, ctx) => {
      const focus = args.trim();
      const before = ctx.getContextUsage()?.tokens;
      ctx.compact({
        customInstructions: focus || undefined,
        onComplete: () => {
          ctx.ui.notify(
            before != null
              ? `Compacted conversation (was ~${before.toLocaleString()} tokens)`
              : "Compacted conversation",
            "info",
          );
        },
        onError: (e) => ctx.ui.notify(`Compaction failed: ${e.message}`, "error"),
      });
    },
  });

  // /resume — pick a previous pi session in this directory and switch to it.
  pi.registerCommand("resume", {
    description: "Resume a previous session in this directory",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/resume needs an interactive session", "warning");
        return;
      }
      const current = ctx.sessionManager.getSessionFile();
      const sessions = (await SessionManager.list(ctx.cwd))
        .filter((s) => s.path !== current)
        .sort((a, b) => b.modified.getTime() - a.modified.getTime());
      if (sessions.length === 0) {
        ctx.ui.notify("No other sessions to resume in this directory", "info");
        return;
      }
      const labels = sessions.map((s, i) => {
        const title = (s.name || s.firstMessage || "(empty session)").replace(/\s+/g, " ").slice(0, 60);
        return `${i + 1}. ${title} — ${s.messageCount} msg, ${s.modified.toLocaleString()}`;
      });
      const picked = await ctx.ui.select("Resume session:", labels);
      if (!picked) return;
      const idx = labels.indexOf(picked);
      if (idx < 0) return;
      await ctx.switchSession(sessions[idx].path, {
        withSession: async (c) => c.ui.notify("Resumed session", "info"),
      });
    },
  });

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
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
      {
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8 (CLI)",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 32000,
      },
      {
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5 (CLI)",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6 (CLI)",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
      {
        id: "claude-haiku-4-5-20251001",
        name: "Claude Haiku 4.5 (CLI)",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
    ],

    streamSimple: streamClaudeCLI,
  });

  registerCliCommands(pi);
}
