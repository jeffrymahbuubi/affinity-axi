// `docs read guide`: the usage guide as an offline docs topic (no Affinity, no connection).

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { make as makeDocs } from "../src/commands/docs.js";
import { renderGuide } from "../src/guide/content.js";
import { DOC_TOPICS } from "./fake-mcp/fixtures.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

const DEAD_URL = "http://127.0.0.1:1";
const read = () => makeDocs(fakeConnect())["docs read"]!;

let server: FakeServer;
beforeEach(async () => {
  server = await startFakeServer();
});
afterEach(async () => {
  await server.close();
});

describe("docs read guide", () => {
  it("--grep answers offline with topic, L<n> lines and no session", async () => {
    const r = await runCommand(read(), ["guide", "--grep", "slot:", "--url", server.url]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("topic: guide\n");
    expect(r.stdout).toMatch(/^matches: [1-9]\d*$/m);
    expect(r.stdout).toMatch(/^ {2}L\d+: /m);
    expect(r.stdout).toContain("slot:<key>");
    expect(server.sessionsOpened()).toBe(0);
    expect(server.calls).toEqual([]);
  });

  it("works with --url pointing at a dead port", async () => {
    const r = await runCommand(read(), ["guide", "--grep", "slot:", "--url", DEAD_URL]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("topic: guide\n");
    expect(r.stdout).toContain("slot:<key>");
  });

  it("--lines 1-3 returns the title lines", async () => {
    const r = await runCommand(read(), ["guide", "--lines", "1-3", "--url", DEAD_URL]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("lines: 1-3");
    expect(r.stdout).toContain("  # affinity-axi usage guide");
    expect(server.sessionsOpened()).toBe(0);
  });

  it("the text is renderGuide() without its final newline", async () => {
    const text = renderGuide().replace(/\n$/, "");
    const r = await runCommand(read(), ["guide", "--full", "--url", DEAD_URL]);
    expect(r.stdout).toContain(`size: ${text.length} chars, ${text.split("\n").length} lines`);
    expect(r.stdout).not.toContain("... (truncated,");
  });

  it("a --grep with many matches is cut at 6000 chars and names the exact --full command", async () => {
    const r = await runCommand(read(), ["guide", "--grep", ".", "--url", DEAD_URL]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\.\.\. \(truncated, \d+ chars total\)/);
    expect(r.stdout).toContain('affinity-axi docs read guide --grep "." --full');
    const content = r.stdout.slice(r.stdout.indexOf("content:\n"), r.stdout.indexOf("  ... (truncated"));
    expect(content.length).toBeGreaterThan(5000);
    expect(content.length).toBeLessThan(7000);
  });

  it("without --grep or --lines the cut stays at 1500 chars", async () => {
    const r = await runCommand(read(), ["guide", "--url", DEAD_URL]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("... (truncated,");
    expect(r.stdout).toContain("affinity-axi docs read guide --full");
    const content = r.stdout.slice(r.stdout.indexOf("content:\n"), r.stdout.indexOf("  ... (truncated"));
    expect(content.length).toBeLessThan(2000);
  });
});

describe("other topics keep connecting and cutting at 1500", () => {
  const big = Array.from({ length: 300 }, (_, i) => `line ${i + 1} ${"y".repeat(20)}`).join("\n");
  beforeEach(() => {
    DOC_TOPICS["big-guide-neighbour.js"] = big;
  });
  afterAll(() => {
    delete DOC_TOPICS["big-guide-neighbour.js"];
  });

  it("a --grep on an SDK topic is still cut at 1500", async () => {
    const r = await runCommand(read(), ["big-guide-neighbour.js", "--grep", "line", "--url", server.url]);
    expect(r.code).toBe(0);
    expect(server.sessionsOpened()).toBeGreaterThan(0);
    expect(r.stdout).toContain("... (truncated,");
    const content = r.stdout.slice(r.stdout.indexOf("content:\n"), r.stdout.indexOf("  ... (truncated"));
    expect(content.length).toBeLessThan(2000);
  });
});
