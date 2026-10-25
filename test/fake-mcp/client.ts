// Test-only MCP client for the fake server. Lets command modules
// be tested in-process without the real transport and registry:
//   const mod = make(fakeConnect());   // reads AFFINITY_MCP_URL or opts.url
//   const r = await runCommand(mod, ["file.js", "--full"]);
// Not a reference for the real transport: it skips timeouts, CRLF edge cases and error mapping.

import { request } from "node:http";
import type { CommandModule } from "../../src/cli/router.js";
import { parseArgs } from "../../src/cli/args.js";
import { AxiError, renderError } from "../../src/output/errors.js";
import { ConnectError, McpError, type AffinityClient, type ConnectFn, type ToolResult } from "../../src/mcp/types.js";
import { PROTOCOL_VERSION } from "./fixtures.js";

export interface RawClient {
  endpoint: string;
  events: Array<{ event: string; data: string }>;
  rpc(method: string, params?: unknown): Promise<Record<string, any>>;
  close(): void;
}

export function post(url: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** Opens GET /sse and resolves once the endpoint frame arrives. */
export function rawConnect(base: string): Promise<RawClient> {
  return new Promise((resolve, reject) => {
    const events: RawClient["events"] = [];
    const waiters = new Map<number, (m: Record<string, any>) => void>();
    let buf = "";
    let nextId = 1;
    const req = request(`${base}/sse`, { headers: { Accept: "text/event-stream" } }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf("\r\n\r\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 4);
          const ev = /^event: (.*)$/m.exec(frame)?.[1] ?? "";
          const data = /^data: (.*)$/m.exec(frame)?.[1] ?? "";
          events.push({ event: ev, data });
          if (ev === "endpoint") {
            resolve({
              endpoint: data,
              events,
              rpc(method, params) {
                const id = nextId++;
                const p = new Promise<Record<string, any>>((r) => waiters.set(id, r));
                void post(`${base}${data}`, JSON.stringify({ jsonrpc: "2.0", id, method, params }));
                return p;
              },
              close: () => req.destroy(),
            });
          } else if (ev === "message") {
            const m = JSON.parse(data);
            waiters.get(m.id)?.(m);
          }
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** ConnectFn over the fake server; URL from opts.url, then AFFINITY_MCP_URL. */
export function fakeConnect(): ConnectFn {
  return async (opts = {}) => {
    const baseUrl = opts.url ?? process.env["AFFINITY_MCP_URL"];
    if (!baseUrl) throw new ConnectError("no fake server url", "set AFFINITY_MCP_URL");
    let raw: RawClient;
    try {
      raw = await rawConnect(baseUrl);
    } catch {
      throw new ConnectError(`cannot reach ${baseUrl}`, "start the fake server");
    }
    const init = await raw.rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: opts.clientName ?? "affinity-axi", version: "0.1.0" },
    });
    const client: AffinityClient = {
      baseUrl,
      serverInfo: init.result.serverInfo,
      async callTool(name, args) {
        const m = await raw.rpc("tools/call", { name, arguments: args });
        if (m.error) throw new McpError(m.error.message);
        return m.result as ToolResult;
      },
      close: () => raw.close(),
    };
    if (opts.readPreamble !== false) await client.callTool("read_sdk_documentation_topic", { filename: "preamble" });
    return client;
  };
}

/** Runs a command in-process like the router does; captures stdout. */
export async function runCommand(mod: CommandModule, argv: string[]): Promise<{ code: number; stdout: string }> {
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => {
    chunks.push(String(s));
    return true;
  }) as typeof process.stdout.write;
  let code: number;
  try {
    code = await mod.run(parseArgs(argv, mod.spec));
  } catch (err) {
    if (!(err instanceof AxiError)) throw err;
    chunks.push(renderError(err) + "\n");
    code = err.exitCode;
  } finally {
    process.stdout.write = write;
  }
  return { code, stdout: chunks.join("") };
}
