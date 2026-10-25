// Minimal SSE client over node:http. Opens GET <base>/sse, parses
// frames (CRLF or LF), ignores heartbeats and comments, and hands `message`
// payloads to the caller once the `endpoint` frame has named the POST URL.

import { request, type ClientRequest } from "node:http";

/** Debug output goes to stderr only when AFFINITY_AXI_DEBUG=1. */
export function debug(msg: string): void {
  if (process.env["AFFINITY_AXI_DEBUG"] === "1") process.stderr.write(`[affinity-axi] ${msg}\n`);
}

export interface SseFrame { event: string; data: string }

/** Incremental frame parser. Tolerates CRLF split across chunks. */
export class FrameParser {
  private buf = "";

  push(chunk: string): SseFrame[] {
    this.buf = (this.buf + chunk).replace(/\r\n/g, "\n");
    const frames: SseFrame[] = [];
    let i: number;
    while ((i = this.buf.indexOf("\n\n")) >= 0) {
      const raw = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      const frame = parseFrame(raw);
      if (frame) frames.push(frame);
    }
    return frames;
  }
}

function parseFrame(raw: string): SseFrame | null {
  let event = "message";
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0 && event === "message") return null;
  return { event, data: data.join("\n") };
}

export type SseFailure = "refused" | "status" | "timeout" | "closed" | "network";

/** Failure to open the stream or to receive the endpoint frame. */
export class SseError extends Error {
  constructor(message: string, readonly reason: SseFailure) {
    super(message);
  }
}

export interface SseHandlers {
  /** Payload of each `message` event. */
  onMessage(data: string): void;
  /** Stream ended after the endpoint was announced (called at most once). */
  onClose(reason: string): void;
}

export interface SseStream {
  /** Absolute URL JSON-RPC requests are POSTed to. */
  readonly postUrl: string;
  close(): void;
}

/** Normalizes a user URL to origin plus path, without a trailing slash or /sse. */
export function normalizeBase(raw: string): string {
  const u = new URL(raw);
  if (u.protocol !== "http:") throw new TypeError(`unsupported protocol ${u.protocol}`);
  const path = u.pathname.replace(/\/+$/, "").replace(/\/sse$/, "");
  return `${u.origin}${path}`;
}

export function openSse(base: string, handlers: SseHandlers, timeoutMs: number): Promise<SseStream> {
  return new Promise<SseStream>((resolve, reject) => {
    let req: ClientRequest | undefined;
    let ready = false;
    let settled = false;
    let closed = false;
    const parser = new FrameParser();

    const fail = (err: SseError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req?.destroy();
      reject(err);
    };
    const timer = setTimeout(
      () => fail(new SseError(`no endpoint frame within ${timeoutMs} ms`, "timeout")),
      timeoutMs,
    );
    const ended = (why: string) => {
      if (!ready) return fail(new SseError(`stream ended before endpoint frame (${why})`, "closed"));
      if (closed) return;
      closed = true;
      handlers.onClose(why);
    };

    req = request(`${base}/sse`, { headers: { Accept: "text/event-stream" }, agent: false }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        fail(new SseError(`HTTP ${res.statusCode} from /sse`, "status"));
        return;
      }
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        for (const frame of parser.push(chunk)) {
          if (frame.event === "endpoint" && !ready) {
            ready = true;
            settled = true;
            clearTimeout(timer);
            resolve({
              postUrl: new URL(frame.data.trim(), `${base}/`).href,
              close: () => req?.destroy(),
            });
          } else if (frame.event === "message" && ready) {
            handlers.onMessage(frame.data);
          } else {
            debug(`sse ${frame.event} frame ignored`);
          }
        }
      });
      res.on("end", () => ended("stream ended"));
      res.on("error", (e) => ended(e.message));
      res.on("close", () => ended("stream closed"));
    });
    req.on("error", (e: NodeJS.ErrnoException) => {
      if (ready) return ended(e.message);
      const refused = e.code === "ECONNREFUSED";
      fail(new SseError(refused ? "connection refused" : (e.code ?? e.message), refused ? "refused" : "network"));
    });
    req.end();
  });
}
