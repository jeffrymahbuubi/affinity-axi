// Self-test for the fake MCP server, using the raw test client so it does
// not depend on the real transport.

import { afterEach, describe, expect, it } from "vitest";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";
import { fakeConnect, post, rawConnect, runCommand, type RawClient as Raw } from "./fake-mcp/client.js";
import { FIXTURE_UUID, GATE_TEXT, TINY_JPEG_B64 } from "./fake-mcp/fixtures.js";

const call = (c: Raw, name: string, args: Record<string, unknown> = {}) => c.rpc("tools/call", { name, arguments: args });

let server: FakeServer | undefined;
let client: Raw | undefined;
afterEach(async () => {
  client?.close();
  await server?.close();
  client = server = undefined;
});

describe("fake MCP server", () => {
  it("announces the endpoint and answers POST with 202 Accepted", async () => {
    server = await startFakeServer();
    client = await rawConnect(server.url);
    expect(client.endpoint).toMatch(/^\/message\?session_id=[0-9a-f-]{36}$/);
    const r = await post(`${server.url}${client.endpoint}`, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(r).toEqual({ status: 202, body: "Accepted" });
  });

  it("returns 404 for an unknown session", async () => {
    server = await startFakeServer();
    const r = await post(`${server.url}/message?session_id=nope`, "{}");
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body)).toEqual({ error: "Session not found" });
  });

  it("rejects any protocol version but 2025-11-25", async () => {
    server = await startFakeServer();
    client = await rawConnect(server.url);
    const bad = await client.rpc("initialize", { protocolVersion: "2024-11-05" });
    expect(bad.error).toEqual({
      code: -32602,
      message: "Unsupported protocol version",
      data: { supported: ["2025-11-25"], requested: "2024-11-05" },
    });
    const ok = await client.rpc("initialize", { protocolVersion: "2025-11-25" });
    expect(ok.result.serverInfo).toEqual({ name: "Affinity", version: "1.0.0" });
    expect((await client.rpc("tools/list")).result.tools).toHaveLength(11);
  });

  it("gates execute_script and doc topics until the preamble is read, per session", async () => {
    server = await startFakeServer();
    server.onScript("ping", "pong\n");
    client = await rawConnect(server.url);
    expect((await call(client, "execute_script", { script: "ping" })).result).toEqual({
      isError: true,
      content: [{ type: "text", text: GATE_TEXT }],
    });
    const topic = (await call(client, "read_sdk_documentation_topic", { filename: "document.js" })).result;
    expect(topic.isError).toBe(false);
    expect(topic.content[0].text).toBe(`ERROR: ${GATE_TEXT}`);

    await call(client, "read_sdk_documentation_topic", { filename: "preamble" });
    expect((await call(client, "execute_script", { script: "ping" })).result.content[0].text).toBe("pong\n");

    const other = await rawConnect(server.url);
    expect((await call(other, "execute_script", { script: "ping" })).result.isError).toBe(true);
    other.close();
    expect(server.calls.filter((c) => c.name === "execute_script")).toHaveLength(3);
  });

  it("renders a JPEG and reports bad index, bad uuid and unknown tool", async () => {
    server = await startFakeServer();
    client = await rawConnect(server.url);
    const ok = (await call(client, "render_spread", { document_session_uuid: FIXTURE_UUID, spread_index: 0 })).result;
    expect(ok.content).toEqual([{ type: "image", mimeType: "image/jpeg", data: TINY_JPEG_B64 }]);
    const oob = (await call(client, "render_spread", { document_session_uuid: FIXTURE_UUID, spread_index: 5 })).result;
    expect(oob.content[0].text).toBe("Spread index out of bounds.");
    const str = (await call(client, "render_spread", { document_session_uuid: FIXTURE_UUID, spread_index: "0" })).result;
    expect(str.isError).toBe(true);
    const uuid = (await call(client, "render_spread", { document_session_uuid: "X", spread_index: 0 })).result;
    expect(uuid.content[0].text).toBe("No document with that Uuid exists.");
    expect((await call(client, "nope")).error).toEqual({ code: -32602, message: "Tool not found: nope" });
    expect((await client.rpc("bogus/method")).error.code).toBe(-32601);
  });

  it("keeps an in-memory script library", async () => {
    server = await startFakeServer();
    client = await rawConnect(server.url);
    expect((await call(client, "list_library_scripts")).result).toEqual({ isError: false, content: [] });
    await call(client, "save_script_to_library", { title: "a", description: "d", code: "console.log(1)" });
    expect((await call(client, "list_library_scripts")).result.content[0].text).toBe("a, ");
    expect((await call(client, "read_library_script", { title: "a" })).result.content[0].text).toBe("console.log(1)");
    const dup = (await call(client, "save_script_to_library", { title: "a", description: "d", code: "x" })).result;
    expect(dup.isError).toBe(true);
    expect(server.library.get("a")?.code).toBe("console.log(1)");
  });

  it("sends heartbeats", async () => {
    server = await startFakeServer({ heartbeatMs: 20 });
    client = await rawConnect(server.url);
    await new Promise((r) => setTimeout(r, 70));
    expect(client.events.filter((e) => e.event === "heartbeat").length).toBeGreaterThan(0);
  });
});

describe("fakeConnect + runCommand", () => {
  it("reads the preamble once and runs a command in-process", async () => {
    server = await startFakeServer();
    server.onScript("hello", "hi\n");
    const connect = fakeConnect();
    const mod = {
      spec: { name: "t", summary: "t", flags: [] },
      async run() {
        const c = await connect({ url: server!.url });
        const r = await c.callTool("execute_script", { script: "hello" });
        c.close();
        process.stdout.write((r.content[0] as { text: string }).text);
        return 0;
      },
    };
    expect(await runCommand(mod, [])).toEqual({ code: 0, stdout: "hi\n" });
    expect(server.calls.map((c) => c.name)).toEqual(["read_sdk_documentation_topic", "execute_script"]);
    expect((await runCommand(mod, ["--bogus"])).code).toBe(2);
  });
});
