// Tests for the SSE transport, JSON-RPC client and connect() against the fake server.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";
import { FIXTURE_UUID, PREAMBLE_TEXT, PROTOCOL_VERSION } from "./fake-mcp/fixtures.js";
import { connect, CONNECT_SUGGESTION, DEFAULT_URL, resolveUrl } from "../src/mcp/connect.js";
import { RpcSession } from "../src/mcp/client.js";
import { FrameParser, normalizeBase } from "../src/mcp/sse.js";
import { ConnectError, McpError, type AffinityClient } from "../src/mcp/types.js";

let server: FakeServer | undefined;
let extra: Server | undefined;
let client: AffinityClient | undefined;
const savedEnv = process.env["AFFINITY_MCP_URL"];
const savedDebug = process.env["AFFINITY_AXI_DEBUG"];

beforeEach(() => {
  delete process.env["AFFINITY_MCP_URL"];
  delete process.env["AFFINITY_AXI_DEBUG"];
});

afterEach(async () => {
  client?.close();
  client = undefined;
  await server?.close();
  server = undefined;
  if (extra) {
    extra.closeAllConnections();
    await new Promise<void>((r) => extra!.close(() => r()));
    extra = undefined;
  }
  if (savedEnv === undefined) delete process.env["AFFINITY_MCP_URL"];
  else process.env["AFFINITY_MCP_URL"] = savedEnv;
  if (savedDebug === undefined) delete process.env["AFFINITY_AXI_DEBUG"];
  else process.env["AFFINITY_AXI_DEBUG"] = savedDebug;
});

/** Starts a custom HTTP server (for failure modes the fake server cannot produce). */
async function customServer(handler: Parameters<typeof createServer>[1]): Promise<string> {
  extra = createServer(handler);
  await new Promise<void>((r) => extra!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(extra.address() as AddressInfo).port}`;
}

function captureStdout(): { text: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((s: string | Uint8Array) => {
    chunks.push(String(s));
    return true;
  }) as typeof process.stdout.write);
  return { text: () => chunks.join("") };
}

describe("FrameParser", () => {
  it("parses CRLF frames, including CRLF split across chunks and several frames per chunk", () => {
    const p = new FrameParser();
    expect(p.push("event: endpoint\r\ndata: /message?session_id=abc\r")).toEqual([]);
    expect(p.push("\n\r\nevent: heartbeat\r\ndata: 0\r\n\r\nevent: message\r\ndata: {\"a\":1}\r\n")).toEqual([
      { event: "endpoint", data: "/message?session_id=abc" },
      { event: "heartbeat", data: "0" },
    ]);
    expect(p.push("\r\n")).toEqual([{ event: "message", data: '{"a":1}' }]);
  });

  it("accepts LF-only frames, joins multi-line data and skips comments", () => {
    const p = new FrameParser();
    expect(p.push(": keep-alive\n\nevent: message\ndata: a\ndata: b\n\n")).toEqual([{ event: "message", data: "a\nb" }]);
  });
});

describe("normalizeBase / resolveUrl", () => {
  it("strips trailing slash and /sse, rejects non-http", () => {
    expect(normalizeBase("http://[::1]:6767/")).toBe("http://[::1]:6767");
    expect(normalizeBase("http://127.0.0.1:1/sse")).toBe("http://127.0.0.1:1");
    expect(() => normalizeBase("ftp://x")).toThrow();
  });

  it("orders AFFINITY_MCP_URL, then opts.url, then the IPv6 default", () => {
    expect(resolveUrl({})).toBe(DEFAULT_URL);
    expect(DEFAULT_URL).toBe("http://[::1]:6767");
    expect(resolveUrl({ url: "http://a:1" })).toBe("http://a:1");
    process.env["AFFINITY_MCP_URL"] = "http://env:2";
    expect(resolveUrl({ url: "http://a:1" })).toBe("http://env:2");
  });
});

describe("connect()", () => {
  it("discovers the endpoint from CRLF frames, handshakes and reads the preamble exactly once", async () => {
    server = await startFakeServer();
    client = await connect({ url: server.url });
    expect(client.baseUrl).toBe(server.url);
    expect(client.serverInfo).toEqual({ name: "Affinity", version: "1.0.0" });
    expect(server.sessionsOpened()).toBe(1);
    const methods = server.requests.map((r) => r.method);
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    const init = server.requests[0]!.params as Record<string, any>;
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(init.clientInfo.name).toBe("affinity-axi");
    expect(server.calls).toEqual([
      expect.objectContaining({ name: "read_sdk_documentation_topic", args: { filename: "preamble" } }),
    ]);
    // gate is open in this session: execute_script works without another preamble read
    server.onScript("hi", "hello\n");
    const r = await client.callTool("execute_script", { script: "console.log('hi')" });
    expect(r).toEqual({ isError: false, content: [{ type: "text", text: "hello\n" }] });
    expect(server.calls.filter((c) => c.args["filename"] === "preamble")).toHaveLength(1);
  });

  it("skips the preamble with readPreamble:false and honours clientName", async () => {
    server = await startFakeServer();
    client = await connect({ url: server.url, readPreamble: false, clientName: "tester" });
    expect(server.calls).toHaveLength(0);
    expect((server.requests[0]!.params as any).clientInfo.name).toBe("tester");
    const gated = await client.callTool("execute_script", { script: "1" });
    expect(gated.isError).toBe(true);
  });

  it("prefers AFFINITY_MCP_URL over opts.url", async () => {
    server = await startFakeServer();
    process.env["AFFINITY_MCP_URL"] = server.url;
    client = await connect({ url: "http://127.0.0.1:1" });
    expect(client.baseUrl).toBe(server.url);
  });

  it("returns the preamble-gated tool results with image content intact", async () => {
    server = await startFakeServer();
    client = await connect({ url: server.url });
    const r = await client.callTool("render_spread", { document_session_uuid: FIXTURE_UUID, spread_index: 0 });
    expect(r.isError).toBe(false);
    expect(r.content).toHaveLength(1);
    expect(r.content[0]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    const bad = await client.callTool("render_spread", { document_session_uuid: FIXTURE_UUID, spread_index: 99 });
    expect(bad.isError).toBe(true);
  });

  it("ignores heartbeats while idle and keeps working", async () => {
    server = await startFakeServer({ heartbeatMs: 10 });
    const out = captureStdout();
    client = await connect({ url: server.url });
    await new Promise((r) => setTimeout(r, 120));
    server.onScript("x", "ok");
    const r = await client.callTool("execute_script", { script: "x" });
    expect(r.content).toEqual([{ type: "text", text: "ok" }]);
    expect(out.text()).toBe("");
  });

  it("correlates replies for two in-flight calls that finish out of order", async () => {
    server = await startFakeServer();
    server.onScript("SLOW", async () => {
      await new Promise((r) => setTimeout(r, 150));
      return "slow-result";
    });
    server.onScript("FAST", "fast-result");
    client = await connect({ url: server.url });
    const order: string[] = [];
    const slow = client.callTool("execute_script", { script: "SLOW" }).then((r) => (order.push("slow"), r));
    const fast = client.callTool("execute_script", { script: "FAST" }).then((r) => (order.push("fast"), r));
    const [s, f] = await Promise.all([slow, fast]);
    expect(order).toEqual(["fast", "slow"]);
    expect(s.content).toEqual([{ type: "text", text: "slow-result" }]);
    expect(f.content).toEqual([{ type: "text", text: "fast-result" }]);
  });

  it("rejects a call with McpError when it times out, and the session keeps working", async () => {
    server = await startFakeServer();
    server.onScript("HANG", () => new Promise<string>((r) => setTimeout(() => r("late"), 400)));
    server.onScript("QUICK", "quick");
    client = await connect({ url: server.url });
    const err = await client.callTool("execute_script", { script: "HANG" }, { timeoutMs: 50 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).suggestion).toContain("dialog");
    await new Promise((r) => setTimeout(r, 450)); // late reply for the dead id must be dropped quietly
    const r = await client.callTool("execute_script", { script: "QUICK" });
    expect(r.content).toEqual([{ type: "text", text: "quick" }]);
  });

  it("surfaces JSON-RPC errors as McpError with the server message and no raw JSON", async () => {
    server = await startFakeServer();
    client = await connect({ url: server.url });
    const err = await client.callTool("no_such_tool", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).message).toBe("Tool not found: no_such_tool");
    expect((err as McpError).message).not.toContain("{");
  });

  it("surfaces the wrong-protocol error as McpError with the server message", async () => {
    server = await startFakeServer();
    const session = await RpcSession.open(server.url, 2000);
    try {
      const err = await session
        .request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } }, 2000)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(McpError);
      expect(err).not.toBeInstanceOf(ConnectError);
      expect((err as McpError).message).toBe("Unsupported protocol version");
    } finally {
      session.close();
    }
  });
});

describe("connect() failures", () => {
  it("maps a refused connection to ConnectError with the URL and the settings suggestion, printing nothing", async () => {
    server = await startFakeServer();
    const dead = server.url;
    await server.close();
    server = undefined;
    const out = captureStdout();
    const err = (await connect({ url: dead }).catch((e: unknown) => e)) as ConnectError;
    expect(err).toBeInstanceOf(ConnectError);
    expect(err.exitCode).toBe(1);
    expect(err.message).toContain(dead);
    expect(err.suggestion).toBe(
      "open Affinity, enable Settings > Model Context Protocol > Enable MCP server, restart Affinity",
    );
    expect(err.suggestion).toBe(CONNECT_SUGGESTION);
    expect(out.text()).toBe("");
  });

  it("maps an invalid URL to ConnectError", async () => {
    await expect(connect({ url: "not a url" })).rejects.toBeInstanceOf(ConnectError);
  });

  it("maps a stream that never announces an endpoint to ConnectError after timeoutMs", async () => {
    const url = await customServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": silent\r\n\r\n");
    });
    const t0 = Date.now();
    const err = await connect({ url, timeoutMs: 150 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectError);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("maps a non-200 /sse answer to ConnectError", async () => {
    const url = await customServer((_req, res) => void res.writeHead(500).end("boom"));
    await expect(connect({ url })).rejects.toBeInstanceOf(ConnectError);
  });

  it("maps 404 Session not found on POST to ConnectError", async () => {
    const url = await customServer((req, res) => {
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: endpoint\r\ndata: /message?session_id=gone\r\n\r\n");
      } else {
        res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"Session not found"}');
      }
    });
    const err = (await connect({ url }).catch((e: unknown) => e)) as ConnectError;
    expect(err).toBeInstanceOf(ConnectError);
    expect(err.suggestion).toBe(CONNECT_SUGGESTION);
  });

  it("maps a handshake that never gets a reply to ConnectError", async () => {
    const url = await customServer((req, res) => {
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: endpoint\r\ndata: /message?session_id=s\r\n\r\n");
      } else {
        req.resume();
        res.writeHead(202).end("Accepted");
      }
    });
    await expect(connect({ url, timeoutMs: 150 })).rejects.toBeInstanceOf(ConnectError);
  });

  it("rejects in-flight calls with McpError when Affinity drops the stream", async () => {
    server = await startFakeServer();
    server.onScript("DROP", () => new Promise<string>(() => {})); // never answers
    client = await connect({ url: server.url });
    const call = client.callTool("execute_script", { script: "DROP" }, { timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 50));
    await server.close();
    server = undefined;
    const err = await call.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).message).toMatch(/closed/);
    await expect(client.callTool("execute_script", { script: "x" })).rejects.toBeInstanceOf(McpError);
  });
});

describe("debug output", () => {
  it("writes to stderr only when AFFINITY_AXI_DEBUG=1, never to stdout", async () => {
    server = await startFakeServer();
    const out = captureStdout();
    const err = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);

    client = await connect({ url: server.url });
    expect(err).not.toHaveBeenCalled();
    client.close();

    process.env["AFFINITY_AXI_DEBUG"] = "1";
    client = await connect({ url: server.url });
    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls[0]![0])).toContain("affinity-axi");
    expect(out.text()).toBe("");
  });

  it("never exposes the preamble text on stdout", async () => {
    server = await startFakeServer();
    const out = captureStdout();
    client = await connect({ url: server.url });
    expect(out.text()).not.toContain(PREAMBLE_TEXT.slice(0, 20));
  });
});
