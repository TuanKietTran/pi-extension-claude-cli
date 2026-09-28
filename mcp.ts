/**
 * Minimal authenticated loopback MCP server for the Claude subprocess.
 *
 * Claude Code tries its native tool protocol before producing structured final
 * output. Disabling every native tool therefore makes it report false "No such
 * tool available" errors instead of requesting Pi tools. This server exposes
 * capture-only MCP facades for the active Pi tools. Their handlers record each
 * request; the provider converts those records into real Pi ToolCall blocks
 * after Claude exits. Tool implementation and execution remain owned by Pi.
 *
 * HTTP keeps the server in-process. It binds 127.0.0.1 on an ephemeral port,
 * requires a per-turn bearer token, and removes its temporary config on close.
 */

import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** MCP protocol version we speak if the client does not name one. */
const PROTOCOL_VERSION = "2025-06-18";
/** Refuse absurd bodies rather than buffering them. */
const MAX_BODY_BYTES = 1_000_000;

export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, any>) => string | Promise<string>;
}

export interface McpHandle {
  url: string;
  /**
   * Path to the --mcp-config file.
   *
   * A file rather than an inline JSON argument because every byte spent on
   * argv comes out of the same fixed budget as the conversation we are actually
   * trying to send — and on Windows that budget is 32 KB for the whole command
   * line, after which spawn fails outright.
   */
  configPath: string;
  /** Ready to pass to `claude --allowedTools`, so the run needs no prompting. */
  allowedTools: string[];
  close(): void;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}

function result(id: JsonRpcMessage["id"], value: unknown) {
  return { jsonrpc: "2.0", id, result: value };
}

function failure(id: JsonRpcMessage["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function dispatchMessage(
  message: JsonRpcMessage,
  serverName: string,
  tools: McpTool[],
): Promise<object | undefined> {
  // Notifications ("initialized", "cancelled", …) get no response at all.
  if (message.id === undefined || message.id === null) return undefined;

  switch (message.method) {
    case "initialize":
      return result(message.id, {
        protocolVersion:
          typeof message.params?.protocolVersion === "string"
            ? message.params.protocolVersion
            : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: serverName, version: "1.0.0" },
      });

    case "ping":
      return result(message.id, {});

    case "tools/list":
      return result(message.id, {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });

    case "tools/call": {
      const tool = tools.find((t) => t.name === message.params?.name);
      if (!tool) return failure(message.id, -32602, `Unknown tool: ${message.params?.name}`);
      try {
        const text = await tool.handler(message.params?.arguments ?? {});
        return result(message.id, { content: [{ type: "text", text }] });
      } catch (error) {
        // A failing tool is a tool result, not a protocol error: report it back
        // as content so Claude can react instead of dropping the connection.
        return result(message.id, {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        });
      }
    }

    default:
      return failure(message.id, -32601, `Method not found: ${message.method}`);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, payload?: unknown): void {
  if (payload === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function startMcpServer(serverName: string, tools: McpTool[]): Promise<McpHandle> {
  const token = randomBytes(24).toString("hex");

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.headers.authorization !== `Bearer ${token}`) {
          send(res, 401, { error: "unauthorized" });
          return;
        }
        // Only the POST half of streamable HTTP is implemented. A client that
        // wants the server-initiated SSE stream is told we do not offer one,
        // which the spec allows and Claude accepts.
        if (req.method !== "POST") {
          send(res, 405, { error: "method not allowed" });
          return;
        }

        const raw = await readBody(req);
        let parsed: JsonRpcMessage | JsonRpcMessage[];
        try {
          parsed = JSON.parse(raw);
        } catch {
          send(res, 400, failure(null, -32700, "Parse error"));
          return;
        }

        if (Array.isArray(parsed)) {
          const responses = (
            await Promise.all(parsed.map((message) => dispatchMessage(message, serverName, tools)))
          ).filter(Boolean);
          send(res, responses.length > 0 ? 200 : 202, responses.length > 0 ? responses : undefined);
          return;
        }

        const response = await dispatchMessage(parsed, serverName, tools);
        send(res, response ? 200 : 202, response);
      } catch (error) {
        try {
          send(res, 500, failure(null, -32603, error instanceof Error ? error.message : String(error)));
        } catch {
          // The socket is already gone; nothing left to report to.
        }
      }
    })();
  });

  // Neither the listener nor its sockets may keep pi alive: a print-mode
  // session must still exit the moment its work is done.
  server.unref();
  server.on("connection", (socket) => socket.unref());

  return new Promise<McpHandle>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("MCP server did not bind a port"));
        return;
      }
      const url = `http://127.0.0.1:${address.port}/mcp`;
      const configPath = join(tmpdir(), `pi-claude-tools-${process.pid}-${randomBytes(4).toString("hex")}.json`);
      try {
        writeFileSync(
          configPath,
          JSON.stringify({
            mcpServers: {
              [serverName]: { type: "http", url, headers: { Authorization: `Bearer ${token}` } },
            },
          }),
          { mode: 0o600 },
        );
      } catch (error) {
        server.close();
        reject(error);
        return;
      }

      resolve({
        url,
        configPath,
        // One server-wide rule, not one per tool: shorter on the command line,
        // and new tools do not need a matching allow entry to be usable.
        allowedTools: [`mcp__${serverName}`],
        close: () => {
          server.close();
          try {
            rmSync(configPath, { force: true });
          } catch {
            // A leftover config in tmp is harmless; its port is already gone.
          }
        },
      });
    });
  });
}
