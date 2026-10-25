// M2: a timed-out tools/call asks the server to cancel (best effort), tells the
// user the script may still be running and logs outcome "timeout".

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { make as makeRun } from "../src/commands/run.js";
import { connect } from "../src/mcp/connect.js";
import { RpcSession, TransportError } from "../src/mcp/client.js";
import { McpError, type ConnectFn } from "../src/mcp/types.js";
import { runCommand } from "./fake-mcp/client.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

const A = "AAAAAAAA-0000-4000-8000-000000000001";
const HINT = "the script may still be running in Affinity and can create or change documents after this";

let server: FakeServer;
let root: string;
let work: string;
const origCwd = process.cwd();
const origUrl = process.env["AFFINITY_MCP_URL"];

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  // A script the server never answers.
  server.onScript("NEVER-ANSWERS", () => new Promise<never>(() => {}));
  root = mkdtempSync(join(tmpdir(), "axi-timeout-"));
  work = join(root, "work");
  mkdirSync(work);
  process.chdir(work);
});

let notifySpy: { mockRestore(): void } | undefined;

afterEach(async () => {
  notifySpy?.mockRestore();
  notifySpy = undefined;
  process.chdir(origCwd);
  if (origUrl === undefined) delete process.env["AFFINITY_MCP_URL"];
  else process.env["AFFINITY_MCP_URL"] = origUrl;
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

const cancels = () => server.requests.filter((r) => r.method === "notifications/cancelled");
const waitFor = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
};
const logLines = (): string[] => {
  const f = join(work, ".affinity-axi", "runs.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
};

describe("tools/call timeout", () => {
  it("sends notifications/cancelled with the request id and rejects with the new hint", async () => {
    const client = await connect({ url: server.url });
    try {
      let err: unknown;
      await client
        .callTool("execute_script", { script: "// NEVER-ANSWERS" }, { timeoutMs: 50 })
        .catch((e: unknown) => (err = e));
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).message).toMatch(/tools\/call timed out after 50 ms/);
      expect((err as TransportError).suggestion).toContain(HINT);
      expect((err as TransportError).suggestion).toContain("do not re-run the same script");
      await waitFor(() => cancels().length > 0);
      const call = server.requests.find((r) => r.method === "tools/call" && JSON.stringify(r.params).includes("NEVER-ANSWERS"))!;
      expect(cancels()).toHaveLength(1);
      expect(cancels()[0]!.id).toBeUndefined();
      expect(cancels()[0]!.params).toMatchObject({ requestId: call.id, reason: "timeout after 50 ms" });
    } finally {
      client.close();
    }
  });

  it("still reports the timeout when the cancel cannot be sent", async () => {
    const client = await connect({ url: server.url });
    try {
      notifySpy = vi.spyOn(RpcSession.prototype, "notify").mockRejectedValue(new TransportError("session closed"));
      await expect(
        client.callTool("execute_script", { script: "// NEVER-ANSWERS" }, { timeoutMs: 50 }),
      ).rejects.toThrow(/timed out after 50 ms/);
      expect(cancels()).toHaveLength(0);
    } finally {
      client.close();
    }
  });

  it("a request that answers in time sends no cancellation", async () => {
    server.onScript("QUICK", "fine\n");
    const client = await connect({ url: server.url });
    try {
      await client.callTool("execute_script", { script: "// QUICK" }, { timeoutMs: 5000 });
      expect(cancels()).toHaveLength(0);
    } finally {
      client.close();
    }
  });
});

describe("run on a timeout", () => {
  it("exits 1 with the hint, logs outcome timeout and attributes the --args document", async () => {
    const run = makeRun(connect);
    const file = join(work, "slow.js");
    writeFileSync(file, "// NEVER-ANSWERS\n");
    const r = await runCommand(run, [file, "--timeout", "50", "--args", JSON.stringify({ uuid: A })]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("timed out after 50 ms");
    expect(r.stdout).toContain(HINT);
    const lines = logLines();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ cmd: "run", outcome: "timeout", documents: [{ uuid: A, path: "" }] });
    await waitFor(() => cancels().length > 0);
    expect(cancels()).toHaveLength(1);
  });

  it("a failure that is not a timeout still logs outcome error", async () => {
    const failing: ConnectFn = async () => ({
      baseUrl: server.url,
      serverInfo: { name: "fake", version: "0" },
      callTool: () => Promise.reject(new McpError("boom")),
      close: () => {},
    });
    const file = join(work, "x.js");
    writeFileSync(file, "1\n");
    const r = await runCommand(makeRun(failing), [file]);
    expect(r.code).toBe(1);
    const lines = logLines();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ outcome: "error", documents: [] });
  });
});
