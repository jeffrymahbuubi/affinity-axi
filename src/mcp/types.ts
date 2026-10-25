// Shared interfaces for the MCP transport, commands and script tooling.
// Keep it free of behaviour so the transport, commands and test doubles can all depend on it.

import { AxiError } from "../output/errors.js";

export interface ContentText { type: "text"; text: string }
export interface ContentImage { type: "image"; mimeType: string; data: string }
export type Content = ContentText | ContentImage;
export interface ToolResult { isError: boolean; content: Content[] }
export interface ServerInfo { name: string; version: string }

export interface AffinityClient {
  readonly baseUrl: string;
  readonly serverInfo: ServerInfo;
  /** tools/call; rejects with McpError on JSON-RPC error or timeout. */
  callTool(name: string, args: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<ToolResult>;
  close(): void;
}
export interface ConnectOptions { url?: string; timeoutMs?: number; readPreamble?: boolean; clientName?: string }
/** Implemented in src/mcp/connect.ts. Throws ConnectError (exit 1) with the Settings suggestion. */
export type ConnectFn = (opts?: ConnectOptions) => Promise<AffinityClient>;

export class McpError extends AxiError {}      // exit 1
export class ConnectError extends AxiError {}  // exit 1, suggestion is the Settings fix

export type ScriptOutcome =
  | { kind: "ok"; text: string }
  | { kind: "not-allowed"; text: string }
  | { kind: "sdk-error"; text: string }
  | { kind: "exception"; error: string; at: string | null; text: string };
export interface AiHit { identifier: string; line: number }
export interface DocInfo { uuid: string; title: string; dirty: boolean; units: string; path: string }
