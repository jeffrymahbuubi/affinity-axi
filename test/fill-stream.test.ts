// `fill` prints the list header before the first record and each row when its record finishes
// (same bytes as before, earlier), and a `renamed` list when a key differs from its data value.
// Fake MCP server; stdout chunks are captured by the test so the open of record 2 can look at them.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApplyReply } from "../src/affinity/fill-script.js";
import { parseArgs } from "../src/cli/args.js";
import { make } from "../src/commands/fill.js";
import { AxiError, renderError } from "../src/output/errors.js";
import { parseToon } from "../src/output/toon.js";
import { fakeConnect } from "./fake-mcp/client.js";
import { FIXTURE_APP } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

let server: FakeServer;
let root: string;
let work: string;
let desktop: string;
const origCwd = process.cwd();
const origUrl = process.env["AFFINITY_MCP_URL"];
const fill = make(fakeConnect());

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  root = mkdtempSync(join(tmpdir(), "axi-fill-stream-"));
  work = join(root, "work");
  desktop = join(root, "Desktop");
  mkdirSync(work);
  mkdirSync(desktop);
  process.chdir(work);
});
afterEach(async () => {
  process.chdir(origCwd);
  if (origUrl === undefined) delete process.env["AFFINITY_MCP_URL"];
  else process.env["AFFINITY_MCP_URL"] = origUrl;
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

const OK_REPLY: ApplyReply = { applied: ["headline"], unknown: [], duplicate: [], mismatch: [], slots: ["slot:headline"], notes: [] };
const uuidFor = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const quoted = (script: string, name: string): string => JSON.parse(new RegExp(`const ${name} = (".*");`).exec(script)![1]!) as string;

/** Runs fill with stdout captured chunk by chunk (one entry per write), like runCommand but readable while the run is going. */
function capture(args: string[]): { chunks: string[]; done: Promise<number> } {
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => {
    chunks.push(String(s));
    return true;
  }) as typeof process.stdout.write;
  const done = (async (): Promise<number> => {
    try {
      return await fill.run(parseArgs(args, fill.spec));
    } catch (err) {
      if (!(err instanceof AxiError)) throw err;
      chunks.push(renderError(err) + "\n");
      return err.exitCode;
    } finally {
      process.stdout.write = write;
    }
  })();
  return { chunks, done };
}

function stub(o: { onOpen?: (n: number) => void; apply?: (n: number) => ApplyReply } = {}): void {
  let opens = 0;
  let applies = 0;
  server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
  server.onScript("affinity-axi:fill-open", () => {
    opens += 1;
    o.onOpen?.(opens);
    return JSON.stringify({ status: "loaded", uuid: uuidFor(opens) });
  });
  server.onScript("affinity-axi:fill-apply", () => JSON.stringify(o.apply ? o.apply(++applies) : OK_REPLY));
  server.onScript("affinity-axi:doc-save", (script) => {
    const path = quoted(script, "outPath");
    writeFileSync(path, `af:${path}`);
    return JSON.stringify({ status: "saved", uuid: "x", path, dirty: false });
  });
  server.onScript("affinity-axi:doc-close", JSON.stringify({ status: "closed", uuid: "x" }));
}

function setup(slugs: string[]): { args: string[]; out: string } {
  const template = join(desktop, "post.af");
  writeFileSync(template, "template");
  writeFileSync(join(work, "posts.json"), JSON.stringify(slugs.map((slug) => ({ slug, headline: "x" }))));
  const out = join(desktop, "out");
  return { args: [template, "--data", join(work, "posts.json"), "--key", "slug", "--out-dir", out], out };
}

const HEADER = (n: number): string => `records[${n}]{key,status,doc,ms,note}:`;

describe("fill streams its rows", () => {
  it("the header and row 1 are on stdout before record 2 is opened, and the final text is the usual form", async () => {
    let atSecondOpen = "";
    let live: string[] = [];
    stub({
      onOpen: (n) => {
        if (n === 2) atSecondOpen = live.join("");
      },
    });
    const { args } = setup(["mar", "apr"]);
    const run = capture(args);
    live = run.chunks;
    const code = await run.done;
    expect(code).toBe(0);
    const lines = atSecondOpen.split("\n");
    expect(lines[0]).toBe(HEADER(2));
    expect(lines[1]).toMatch(/^ {2}mar,ok,/);
    expect(atSecondOpen).not.toContain("apr");
    expect(atSecondOpen).not.toContain("saved:");

    const text = run.chunks.join("");
    const all = text.split("\n");
    expect(all[0]).toBe(HEADER(2));
    expect(all[1]).toMatch(/^ {2}mar,ok,/);
    expect(all[2]).toMatch(/^ {2}apr,ok,/);
    expect(all[3]).toMatch(/^saved: /);
    expect(all[4]).toBe("exported: 0");
    expect(run.chunks[0]).toBe(HEADER(2) + "\n"); // one write per line, not one block at the end
    expect(parseToon(text).ok).toBe(true);
    expect(text).not.toContain("renamed");
  });

  it("a stopped run prints the skipped rows too", async () => {
    stub({ apply: () => ({ ...OK_REPLY, applied: [], unknown: ["x"] }) });
    const { args } = setup(["mar", "apr", "may"]);
    const run = capture(args);
    expect(await run.done).toBe(1);
    const all = run.chunks.join("").split("\n");
    expect(all[0]).toBe(HEADER(3));
    expect(all[1]).toMatch(/^ {2}mar,failed,/);
    expect(all[2]).toMatch(/^ {2}apr,skipped,/);
    expect(all[3]).toMatch(/^ {2}may,skipped,/);
    expect(all[4]).toMatch(/^saved: /);
  });
});

describe("fill renamed keys", () => {
  it("keeps typed dashes, saves under the changed key and lists the rename", async () => {
    stub();
    const { args, out } = setup(["Hello World", "a--b"]);
    const run = capture(args);
    expect(await run.done).toBe(0);
    const text = run.chunks.join("");
    expect(existsSync(join(out, "Hello-World.af"))).toBe(true);
    expect(existsSync(join(out, "a--b.af"))).toBe(true);
    expect(text).toContain("renamed[1]{value,key}:");
    expect(text).toContain("  Hello World,Hello-World");
    expect(text.split("renamed[")[1]).not.toContain("a--b"); // a--b is in the table, not in the renamed list
    expect(parseToon(text).ok).toBe(true);
  });

  it("twelve changed keys print the first ten and the total", async () => {
    stub();
    const slugs = Array.from({ length: 12 }, (_, i) => `item ${i + 1}`);
    const { args } = setup(slugs);
    const run = capture(args);
    expect(await run.done).toBe(0);
    const text = run.chunks.join("");
    expect(text).toContain("renamed[10 of 12 total]{value,key}:");
    expect(text).toContain("  item 10,item-10");
    expect(text).not.toContain("  item 11,item-11");
  });

  it("no list when every key is as typed", async () => {
    stub();
    const { args } = setup(["mar", "apr"]);
    const run = capture(args);
    expect(await run.done).toBe(0);
    expect(run.chunks.join("")).not.toContain("renamed");
  });
});

describe("fill --help", () => {
  it("the --data description says what a field and a missing field do", () => {
    const data = fill.spec.flags.find((f) => f.name === "data")!;
    expect(data.description.startsWith("records: a .json array of objects, or a .csv with a header row (required). Each field fills the element named slot:<field>; an empty value blanks a text slot and keeps its style, a field the record does not have leaves the slot as the template has it (with --hide-missing both hide the slot). A picture slot may be")).toBe(true);
  });
});
