// Fake Affinity MCP server (SSE transport) for tests. Mirrors the wire facts
// observed from a live Affinity so tests can run without it. Listens on IPv4
// loopback; point the CLI at it with AFFINITY_MCP_URL=<url>.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { ToolResult } from "../../src/mcp/types.js";
import {
  BAD_UUID_TEXT, DOC_LIST, DOC_TOPICS, FIXTURE_SPREADS, GATE_TEXT, INSTRUCTIONS, PREAMBLE_TEXT,
  PROTOCOL_VERSION, SERVER_INFO, SPREAD_OOB_TEXT, TOOLS, image, text, typeErrorText,
} from "./fixtures.js";

export interface FakeCall { session: string; name: string; args: Record<string, unknown> }
export interface FakeRequest { session: string; method: string; id: unknown; params: unknown }

export type ScriptReply = string | ToolResult;
export type ScriptHandler = ScriptReply | ((script: string) => ScriptReply | Promise<ScriptReply>);

export interface LibraryEntry { description: string; code: string }

export interface FakeServerOptions {
  /** Heartbeat period in ms (default 2000, like the real server). */
  heartbeatMs?: number;
  /** Documents render_spread knows: uuid -> spread count. */
  spreads?: Record<string, number>;
}

export interface FakeServer {
  url: string;
  /** Every tools/call, in arrival order. */
  calls: FakeCall[];
  /** Every JSON-RPC message (requests and notifications), in arrival order. */
  requests: FakeRequest[];
  /** In-memory Affinity script library (title -> entry). */
  library: Map<string, LibraryEntry>;
  /** Hints stored by add_sdk_hint. */
  hints: string[];
  /** Number of SSE streams opened so far. */
  sessionsOpened(): number;
  /**
   * Stub execute_script: the first registered handler whose substring occurs
   * in the script answers. A string reply becomes an ok text result.
   * Unmatched scripts return empty ok text.
   */
  onScript(substring: string, reply: ScriptHandler): void;
  close(): Promise<void>;
}

interface Session { id: string; res: ServerResponse; preambleRead: boolean; beat: NodeJS.Timeout; n: number }

function sseWrite(res: ServerResponse, event: string, data: string): void {
  res.write(`event: ${event}\r\ndata: ${data}\r\n\r\n`);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (body += c));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export async function startFakeServer(opts: FakeServerOptions = {}): Promise<FakeServer> {
  const heartbeatMs = opts.heartbeatMs ?? 2000;
  const spreads = opts.spreads ?? FIXTURE_SPREADS;
  const sessions = new Map<string, Session>();
  const handlers: Array<[string, ScriptHandler]> = [];
  const calls: FakeCall[] = [];
  const requests: FakeRequest[] = [];
  const library = new Map<string, LibraryEntry>();
  const hints: string[] = [];
  let opened = 0;

  async function runScript(script: string): Promise<ToolResult> {
    const hit = handlers.find(([sub]) => script.includes(sub));
    if (!hit) return text("");
    const h = hit[1];
    const reply = typeof h === "function" ? await h(script) : h;
    return typeof reply === "string" ? text(reply) : reply;
  }

  function requireString(args: Record<string, unknown>, key: string): ToolResult | null {
    return typeof args[key] === "string" ? null : text(typeErrorText("string", args[key]), true);
  }

  function renderCheck(args: Record<string, unknown>): ToolResult | null {
    const bad = requireString(args, "document_session_uuid");
    if (bad) return bad;
    if (!(String(args["document_session_uuid"]) in spreads)) return text(BAD_UUID_TEXT, true);
    return null;
  }

  async function callTool(s: Session, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case "execute_script": {
        if (!s.preambleRead) return text(GATE_TEXT, true);
        return requireString(args, "script") ?? runScript(String(args["script"]));
      }
      case "read_sdk_documentation_topic": {
        const bad = requireString(args, "filename");
        if (bad) return bad;
        const file = String(args["filename"]);
        if (file === "preamble") {
          s.preambleRead = true;
          return text(PREAMBLE_TEXT);
        }
        if (!s.preambleRead) return text(`ERROR: ${GATE_TEXT}`);
        const topic = DOC_TOPICS[file];
        // ASSUMED: unknown topic text.
        return topic === undefined ? text(`ERROR: No documentation topic named '${file}'.`) : text(topic);
      }
      case "list_sdk_documentation":
        return text(DOC_LIST.join("\n"));
      case "render_spread": {
        const bad = renderCheck(args);
        if (bad) return bad;
        const idx = args["spread_index"];
        if (typeof idx !== "number") return text(typeErrorText("number", idx), true);
        const count = spreads[String(args["document_session_uuid"])]!;
        if (!Number.isInteger(idx) || idx < 0 || idx >= count) return text(SPREAD_OOB_TEXT, true);
        return image();
      }
      case "render_selection":
        return renderCheck(args) ?? image();
      case "search_sdk_hints":
        return requireString(args, "prompt") ?? text(hints.join("\n"));
      case "add_sdk_hint": {
        const bad = requireString(args, "hint");
        if (bad) return bad;
        hints.push(String(args["hint"]));
        return text("Hint added."); // ASSUMED wording
      }
      case "list_library_scripts":
        // Verified live: an empty library returns no text content; otherwise one
        // comma-separated line with a trailing comma ("Title A, Title B, ").
        return library.size === 0 ? { isError: false, content: [] } : text([...library.keys()].map((k) => `${k}, `).join(""));
      case "read_library_script": {
        const bad = requireString(args, "title");
        if (bad) return bad;
        const e = library.get(String(args["title"]));
        return e ? text(e.code) : text("No script with that title exists.", true); // ASSUMED wording
      }
      case "save_script_to_library": {
        for (const k of ["title", "description", "code"]) {
          const bad = requireString(args, k);
          if (bad) return bad;
        }
        const title = String(args["title"]);
        if (library.has(title)) return text("A script with that title already exists.", true); // ASSUMED
        library.set(title, { description: String(args["description"]), code: String(args["code"]) });
        return text("Script saved."); // ASSUMED wording
      }
      case "report_sdk_issue":
        return requireString(args, "description") ?? text("Issue reported."); // ASSUMED wording
      default:
        throw Object.assign(new Error(`Tool not found: ${name}`), { code: -32602 });
    }
  }

  async function handleRpc(s: Session, msg: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const id = msg["id"];
    const method = String(msg["method"] ?? "");
    const params = (msg["params"] ?? {}) as Record<string, unknown>;
    requests.push({ session: s.id, method, id, params: msg["params"] });
    const reply = (body: Record<string, unknown>) => (id === undefined ? null : { jsonrpc: "2.0", id, ...body });
    const fail = (code: number, message: string, data?: unknown) =>
      reply({ error: data === undefined ? { code, message } : { code, message, data } });

    if (method.startsWith("notifications/")) return null;
    if (method === "initialize") {
      const requested = params["protocolVersion"];
      if (requested !== PROTOCOL_VERSION) {
        return fail(-32602, "Unsupported protocol version", { supported: [PROTOCOL_VERSION], requested });
      }
      return reply({
        result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS },
      });
    }
    if (method === "tools/list") return reply({ result: { tools: TOOLS } });
    if (method === "tools/call") {
      const name = String(params["name"] ?? "");
      const args = (params["arguments"] ?? {}) as Record<string, unknown>;
      calls.push({ session: s.id, name, args });
      try {
        return reply({ result: await callTool(s, name, args) });
      } catch (err) {
        const e = err as Error & { code?: number };
        return fail(e.code ?? -32603, e.message);
      }
    }
    return fail(-32601, `Method not found: ${method}`);
  }

  function openStream(res: ServerResponse): void {
    const id = randomUUID();
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    });
    const s: Session = { id, res, preambleRead: false, n: 0, beat: setInterval(() => sseWrite(res, "heartbeat", String(s.n++)), heartbeatMs) };
    sessions.set(id, s);
    opened++;
    res.on("close", () => {
      clearInterval(s.beat);
      sessions.delete(id);
    });
    sseWrite(res, "endpoint", `/message?session_id=${id}`);
  }

  async function postMessage(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const s = sessions.get(url.searchParams.get("session_id") ?? "");
    const body = await readBody(req);
    if (!s) {
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Session not found" }));
      return;
    }
    res.writeHead(202, { "Content-Type": "text/plain" }).end("Accepted");
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(body) as Record<string, unknown>;
    } catch {
      sseWrite(s.res, "message", JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
      return;
    }
    const out = await handleRpc(s, msg);
    if (out && sessions.has(s.id)) sseWrite(s.res, "message", JSON.stringify(out));
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/sse") return openStream(res);
    if (req.method === "POST" && url.pathname === "/message") {
      postMessage(req, res, url).catch(() => res.headersSent || res.writeHead(500).end());
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not Found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    requests,
    library,
    hints,
    sessionsOpened: () => opened,
    onScript(substring, reply) {
      handlers.push([substring, reply]);
    },
    close() {
      for (const s of sessions.values()) {
        clearInterval(s.beat);
        s.res.end();
      }
      sessions.clear();
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
