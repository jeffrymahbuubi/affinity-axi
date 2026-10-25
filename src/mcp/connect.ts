// connect(): resolve URL, open one SSE session, initialize, notify, read the
// preamble. Everything the handshake costs stays off stdout.

import { readFileSync } from "node:fs";
import { ConnectError, McpError, type ConnectFn, type ConnectOptions, type ServerInfo } from "./types.js";
import { RpcSession, TransportError, createClient } from "./client.js";
import { SseError, debug, normalizeBase } from "./sse.js";

export const DEFAULT_URL = "http://[::1]:6767";
export const PROTOCOL_VERSION = "2025-11-25";
export const DEFAULT_TIMEOUT_MS = 10_000;
/** One retry of the preamble read after Affinity answers isError (seen once as a flake). */
export const PREAMBLE_RETRY_MS = 300;
/** Suggestion shown for every refused connection. */
export const CONNECT_SUGGESTION =
  "open Affinity, enable Settings > Model Context Protocol > Enable MCP server, restart Affinity";

/** Resolution order: AFFINITY_MCP_URL, then the --url option, then the IPv6 default. */
export function resolveUrl(opts: Pick<ConnectOptions, "url"> = {}): string {
  const env = process.env["AFFINITY_MCP_URL"];
  return (env && env.trim()) || opts.url || DEFAULT_URL;
}

export function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function unreachable(url: string, why: string): ConnectError {
  return new ConnectError(`cannot reach Affinity MCP server at ${url} (${why})`, CONNECT_SUGGESTION);
}

export const connect: ConnectFn = async (opts = {}) => {
  const requested = resolveUrl(opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let base: string;
  try {
    base = normalizeBase(requested);
  } catch {
    throw new ConnectError(`invalid Affinity MCP URL ${requested}`, "use an http URL such as " + DEFAULT_URL);
  }
  debug(`connecting to ${base}`);

  let session: RpcSession;
  try {
    session = await RpcSession.open(base, timeoutMs);
  } catch (err) {
    if (err instanceof SseError) throw unreachable(base, err.message);
    throw err;
  }

  try {
    const init = (await session.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: opts.clientName ?? "affinity-axi", version: version() },
      },
      timeoutMs,
    )) as { serverInfo?: Partial<ServerInfo> } | null;
    await session.notify("notifications/initialized");
    const info: ServerInfo = {
      name: String(init?.serverInfo?.name ?? "Affinity"),
      version: String(init?.serverInfo?.version ?? "unknown"),
    };
    const client = createClient(session, info);
    if (opts.readPreamble !== false) {
      const readPre = () => client.callTool("read_sdk_documentation_topic", { filename: "preamble" }, { timeoutMs });
      let pre = await readPre();
      if (pre.isError) {
        debug("preamble refused once, retrying");
        await new Promise((r) => setTimeout(r, PREAMBLE_RETRY_MS));
        pre = await readPre();
      }
      if (pre.isError) throw new McpError("Affinity refused to serve the SDK preamble");
      debug("preamble read");
    }
    return client;
  } catch (err) {
    session.close();
    if (err instanceof TransportError) throw unreachable(base, err.message);
    throw err;
  }
};
