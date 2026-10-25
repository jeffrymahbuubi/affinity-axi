// JSON-RPC 2.0 over the Affinity SSE transport. Requests are POSTed to the
// endpoint announced by the stream; replies come back as `message` events and
// are correlated by id.

import { request } from "node:http";
import { McpError, type AffinityClient, type Content, type ServerInfo, type ToolResult } from "./types.js";
import { debug, openSse, type SseStream } from "./sse.js";

export const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/** Connection-level failure: refused, lost session, stream closed, timeout. */
export class TransportError extends McpError {}

interface Pending {
  method: string;
  resolve(result: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

function post(url: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { "Content-Type": "application/json" }, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** One SSE session: raw JSON-RPC request/notify plus lifecycle. */
export class RpcSession {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private lost: string | null = null;
  private stream: SseStream | undefined;

  private constructor(readonly baseUrl: string) {}

  static async open(baseUrl: string, timeoutMs: number): Promise<RpcSession> {
    const session = new RpcSession(baseUrl);
    session.stream = await openSse(
      baseUrl,
      {
        onMessage: (data) => session.onMessage(data),
        onClose: (why) => session.fail(`Affinity closed the MCP stream (${why})`),
      },
      timeoutMs,
    );
    debug(`session open, post url ${session.stream.postUrl}`);
    return session;
  }

  private onMessage(data: string): void {
    let msg: { id?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
    try {
      msg = JSON.parse(data);
    } catch {
      debug(`unparseable message ignored: ${data.slice(0, 80)}`);
      return;
    }
    const p = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
    if (!p) return debug(`message with unknown id ${String(msg.id)} ignored`);
    this.pending.delete(msg.id as number);
    clearTimeout(p.timer);
    if (msg.error) {
      debug(`rpc error for ${p.method}: ${JSON.stringify(msg.error)}`);
      p.reject(new McpError(String(msg.error.message ?? `${p.method} failed`)));
    } else p.resolve(msg.result);
  }

  private fail(reason: string): void {
    if (this.lost !== null) return;
    this.lost = reason;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new TransportError(reason));
      this.pending.delete(id);
    }
  }

  /** Sends a request and resolves with its `result`; rejects with McpError. */
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.lost !== null || !this.stream) return Promise.reject(new TransportError(this.lost ?? "session closed"));
    const id = this.nextId++;
    const url = this.stream.postUrl;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const hint =
          method === "tools/call"
            ? "Affinity may be waiting on a dialog (e.g. a save prompt); check the app before retrying, and do not re-run the same script"
            : undefined;
        reject(new TransportError(`${method} timed out after ${timeoutMs} ms`, hint));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.send(url, { jsonrpc: "2.0", id, method, params }).catch((err: Error) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /** Sends a notification (no reply expected). */
  async notify(method: string, params?: unknown): Promise<void> {
    if (this.lost !== null || !this.stream) throw new TransportError(this.lost ?? "session closed");
    await this.send(this.stream.postUrl, { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  private async send(url: string, payload: unknown): Promise<void> {
    let res: { status: number; body: string };
    try {
      res = await post(url, JSON.stringify(payload));
    } catch (err) {
      throw new TransportError(`cannot reach Affinity (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`);
    }
    if (res.status === 202) return;
    debug(`POST ${res.status}: ${res.body.slice(0, 120)}`);
    if (res.status === 404) throw new TransportError("Affinity MCP session not found (Affinity restarted?)");
    throw new McpError(`Affinity answered HTTP ${res.status} to a JSON-RPC request`);
  }

  close(): void {
    this.fail("client closed");
    this.stream?.close();
  }
}

function toContent(raw: unknown): Content[] {
  if (!Array.isArray(raw)) return [];
  const out: Content[] = [];
  for (const c of raw as Array<Record<string, unknown>>) {
    if (c?.["type"] === "text" && typeof c["text"] === "string") out.push({ type: "text", text: c["text"] });
    else if (c?.["type"] === "image" && typeof c["data"] === "string") {
      out.push({ type: "image", mimeType: String(c["mimeType"] ?? "image/jpeg"), data: c["data"] });
    }
  }
  return out;
}

export function createClient(session: RpcSession, serverInfo: ServerInfo): AffinityClient {
  return {
    baseUrl: session.baseUrl,
    serverInfo,
    async callTool(name, args, opts) {
      const result = (await session.request(
        "tools/call",
        { name, arguments: args },
        opts?.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      )) as { isError?: unknown; content?: unknown } | null;
      if (!result || typeof result !== "object") throw new McpError(`${name} returned no result`);
      const tr: ToolResult = { isError: result.isError === true, content: toContent(result.content) };
      return tr;
    },
    close: () => session.close(),
  };
}
