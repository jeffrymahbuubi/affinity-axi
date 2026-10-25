// connect(): URL precedence, the package-version fallbacks, a failed preamble and the
// non-transport failure paths that the real fake server cannot produce on its own.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";
import { connect, CONNECT_SUGGESTION, DEFAULT_URL, PREAMBLE_RETRY_MS, resolveUrl, version } from "../src/mcp/connect.js";
import { RpcSession, TransportError } from "../src/mcp/client.js";
import { ConnectError, McpError, type AffinityClient } from "../src/mcp/types.js";

// package.json reads can be steered per test; every other read goes to the real file system.
const pkg = vi.hoisted(() => ({ mode: "real" as "real" | "throw" | "empty" }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    readFileSync: ((path: unknown, ...rest: unknown[]) => {
      if (typeof path !== "string" && !(path instanceof URL)) return (real.readFileSync as any)(path, ...rest);
      const isPkg = String(path).endsWith("package.json");
      if (isPkg && pkg.mode === "throw") throw new Error("EACCES");
      if (isPkg && pkg.mode === "empty") return "{}";
      return (real.readFileSync as any)(path, ...rest);
    }) as typeof real.readFileSync,
  };
});

let server: FakeServer | undefined;
let client: AffinityClient | undefined;
const savedEnv = process.env["AFFINITY_MCP_URL"];

beforeEach(() => {
  delete process.env["AFFINITY_MCP_URL"];
  pkg.mode = "real";
});

afterEach(async () => {
  client?.close();
  client = undefined;
  await server?.close();
  server = undefined;
  if (savedEnv === undefined) delete process.env["AFFINITY_MCP_URL"];
  else process.env["AFFINITY_MCP_URL"] = savedEnv;
});

describe("resolveUrl precedence", () => {
  it("uses the environment, then the option, then the default; blank values do not count", () => {
    expect(resolveUrl()).toBe(DEFAULT_URL);
    expect(resolveUrl({ url: "http://opt:1" })).toBe("http://opt:1");
    process.env["AFFINITY_MCP_URL"] = "  http://env:2  ";
    expect(resolveUrl({ url: "http://opt:1" })).toBe("http://env:2");
    process.env["AFFINITY_MCP_URL"] = "   ";
    expect(resolveUrl({ url: "http://opt:1" })).toBe("http://opt:1");
    process.env["AFFINITY_MCP_URL"] = "";
    expect(resolveUrl()).toBe(DEFAULT_URL);
  });

  it("connects to the option URL when the environment is blank", async () => {
    server = await startFakeServer();
    process.env["AFFINITY_MCP_URL"] = " ";
    client = await connect({ url: server.url });
    expect(client.baseUrl).toBe(server.url);
  });
});

describe("clientInfo version", () => {
  const sentVersion = (s: FakeServer): unknown => (s.requests[0]!.params as any).clientInfo.version;

  it("reports the version from package.json", async () => {
    server = await startFakeServer();
    client = await connect({ url: server.url, readPreamble: false });
    expect(version()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(sentVersion(server)).toBe(version());
  });

  it("falls back to 0.0.0 when package.json cannot be read", async () => {
    pkg.mode = "throw";
    server = await startFakeServer();
    client = await connect({ url: server.url, readPreamble: false });
    expect(sentVersion(server)).toBe("0.0.0");
  });

  it("falls back to 0.0.0 when package.json has no version field", async () => {
    pkg.mode = "empty";
    server = await startFakeServer();
    client = await connect({ url: server.url, readPreamble: false });
    expect(sentVersion(server)).toBe("0.0.0");
  });
});

describe("connect() failure paths", () => {
  it("rejects with McpError when Affinity refuses to serve the preamble, and closes the session", async () => {
    server = await startFakeServer();
    const real = RpcSession.prototype.request;
    const closed = vi.spyOn(RpcSession.prototype, "close");
    let calls = 0;
    vi.spyOn(RpcSession.prototype, "request").mockImplementation(function (this: RpcSession, method, params, timeoutMs) {
      if (method === "tools/call") {
        calls += 1;
        return Promise.resolve({ isError: true, content: [{ type: "text", text: "no" }] });
      }
      return real.call(this, method, params, timeoutMs);
    });
    const err = await connect({ url: server.url }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err).not.toBeInstanceOf(ConnectError);
    expect((err as McpError).message).toBe("Affinity refused to serve the SDK preamble");
    expect(closed).toHaveBeenCalled();
    expect(calls).toBe(2);
  });

  it("one refusal then success connects and reads the preamble twice", async () => {
    server = await startFakeServer();
    const real = RpcSession.prototype.request;
    let calls = 0;
    vi.spyOn(RpcSession.prototype, "request").mockImplementation(function (this: RpcSession, method, params, timeoutMs) {
      if (method === "tools/call") {
        calls += 1;
        if (calls === 1) return Promise.resolve({ isError: true, content: [{ type: "text", text: "busy" }] });
      }
      return real.call(this, method, params, timeoutMs);
    });
    const t0 = Date.now();
    client = await connect({ url: server.url });
    expect(calls).toBe(2);
    expect(PREAMBLE_RETRY_MS).toBe(300);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(PREAMBLE_RETRY_MS - 20);
  });

  it("a transport error during the retry maps to ConnectError", async () => {
    server = await startFakeServer();
    const real = RpcSession.prototype.request;
    let calls = 0;
    vi.spyOn(RpcSession.prototype, "request").mockImplementation(function (this: RpcSession, method, params, timeoutMs) {
      if (method === "tools/call") {
        calls += 1;
        if (calls === 1) return Promise.resolve({ isError: true, content: [{ type: "text", text: "busy" }] });
        return Promise.reject(new TransportError("tools/call timed out after 5 ms"));
      }
      return real.call(this, method, params, timeoutMs);
    });
    const err = (await connect({ url: server.url }).catch((e: unknown) => e)) as ConnectError;
    expect(err).toBeInstanceOf(ConnectError);
    expect(err.message).toBe(`cannot reach Affinity MCP server at ${server.url} (tools/call timed out after 5 ms)`);
    expect(calls).toBe(2);
  });

  it("maps a transport failure during the handshake to ConnectError with the settings suggestion", async () => {
    server = await startFakeServer();
    vi.spyOn(RpcSession.prototype, "request").mockRejectedValue(new TransportError("initialize timed out after 5 ms"));
    const err = (await connect({ url: server.url }).catch((e: unknown) => e)) as ConnectError;
    expect(err).toBeInstanceOf(ConnectError);
    expect(err.message).toBe(`cannot reach Affinity MCP server at ${server.url} (initialize timed out after 5 ms)`);
    expect(err.suggestion).toBe(CONNECT_SUGGESTION);
  });

  it("passes a non-transport error from the handshake through untouched", async () => {
    server = await startFakeServer();
    const boom = new McpError("server said no");
    vi.spyOn(RpcSession.prototype, "request").mockRejectedValue(boom);
    await expect(connect({ url: server.url })).rejects.toBe(boom);
  });

  it("rethrows an unexpected error from opening the session instead of calling it a refused connection", async () => {
    const boom = new Error("socket exploded");
    vi.spyOn(RpcSession, "open").mockRejectedValue(boom);
    await expect(connect({ url: "http://127.0.0.1:1" })).rejects.toBe(boom);
  });

  it("falls back to Affinity / unknown when the server reports no serverInfo", async () => {
    server = await startFakeServer();
    const real = RpcSession.prototype.request;
    vi.spyOn(RpcSession.prototype, "request").mockImplementation(function (this: RpcSession, method, params, timeoutMs) {
      if (method === "initialize") return Promise.resolve(null);
      return real.call(this, method, params, timeoutMs);
    });
    client = await connect({ url: server.url });
    expect(client.serverInfo).toEqual({ name: "Affinity", version: "unknown" });
  });

  it("stringifies partial serverInfo fields", async () => {
    server = await startFakeServer();
    const real = RpcSession.prototype.request;
    vi.spyOn(RpcSession.prototype, "request").mockImplementation(function (this: RpcSession, method, params, timeoutMs) {
      if (method === "initialize") return Promise.resolve({ serverInfo: { name: "Custom" } });
      return real.call(this, method, params, timeoutMs);
    });
    client = await connect({ url: server.url });
    expect(client.serverInfo).toEqual({ name: "Custom", version: "unknown" });
  });

  it("rejects an invalid URL with ConnectError naming it and suggesting the default", async () => {
    const err = (await connect({ url: "ftp://nope" }).catch((e: unknown) => e)) as ConnectError;
    expect(err).toBeInstanceOf(ConnectError);
    expect(err.message).toBe("invalid Affinity MCP URL ftp://nope");
    expect(err.suggestion).toBe(`use an http URL such as ${DEFAULT_URL}`);
  });
});
