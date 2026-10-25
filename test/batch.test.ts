// `batch`: JSON/CSV data, validation before connecting, one connection for N
// records, failure handling, save+close ordering, limit. Fake MCP server.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findDocUuid, make } from "../src/commands/batch.js";
import { deriveKeys, loadRecords, parseCsv, sanitizeKey } from "../src/commands/batch-data.js";
import { readManifest } from "../src/affinity/manifest.js";
import { readRuns } from "../src/affinity/runlog.js";
import { parseToon } from "../src/output/toon.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_APP } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

let server: FakeServer;
let root: string;
let work: string;
let desktop: string;
const origCwd = process.cwd();
const origUrl = process.env["AFFINITY_MCP_URL"];

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  root = mkdtempSync(join(tmpdir(), "axi-batch-"));
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

const batch = make(fakeConnect());

function write(name: string, body: string): string {
  const p = join(work, name);
  writeFileSync(p, body);
  return p;
}

const POSTS = JSON.stringify([
  { slug: "a", headline: "Satu" },
  { slug: "b", headline: "Dua" },
  { slug: "c", headline: "Tiga" },
]);

const uuidFor = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scripts = (): string[] => server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"]));
const argsOf = (script: string): Record<string, unknown> => JSON.parse(/^const ARGS = (.*?); /.exec(script)![1]!) as Record<string, unknown>;

/** Template stub: every script containing TEMPLATE_MARK logs a fresh {"uuid"} line; `fail(index)` can make one throw. */
function stubTemplate(fail?: (args: Record<string, unknown>) => boolean): void {
  let n = 0;
  server.onScript("TEMPLATE_MARK", (script) => {
    const args = argsOf(script);
    if (fail?.(args)) return `building...\nError: boom ${String(args["key"])}\n    at main:3:1`;
    return JSON.stringify({ uuid: uuidFor(++n), key: args["key"] });
  });
}

function stubApp(): void {
  server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
}

/** doc-save writes the file like Affinity would; doc-close reports closed. */
function stubSaveClose(opts: { dirtyAfterSave?: boolean } = {}): void {
  server.onScript("affinity-axi:doc-save", (script) => {
    const path = JSON.parse(/const outPath = (".*");/.exec(script)![1]!) as string;
    writeFileSync(path, "af");
    return JSON.stringify({ status: "saved", uuid: "x", path, dirty: opts.dirtyAfterSave === true });
  });
  server.onScript("affinity-axi:doc-close", JSON.stringify({ status: "closed", uuid: "x" }));
}

const TEMPLATE = "/* TEMPLATE_MARK */\nconst d = axiDoc(10, 10);\nconsole.log(JSON.stringify({uuid: String(d.sessionUuid)}));\n";

describe("batch data", () => {
  it("parseCsv handles quotes, commas, doubled quotes and newlines inside quotes", () => {
    const rows = parseCsv('slug,headline,note\r\na,"Halo, dunia","say ""hi"""\r\nb,"two\nlines",\r\n');
    expect(rows).toEqual([
      ["slug", "headline", "note"],
      ["a", "Halo, dunia", 'say "hi"'],
      ["b", "two\nlines", ""],
    ]);
  });

  it("parseCsv rejects an unterminated quote", () => {
    expect(() => parseCsv('a,"b')).toThrow(/unterminated/);
  });

  it("loads a JSON array and a CSV file as records", () => {
    const j = write("d.json", POSTS);
    expect(loadRecords(j)).toHaveLength(3);
    const c = write("d.csv", '﻿slug,headline\na,"Halo, dunia"\n\nb,Dua\n');
    expect(loadRecords(c)).toEqual([
      { slug: "a", headline: "Halo, dunia" },
      { slug: "b", headline: "Dua" },
    ]);
  });

  it("rejects bad data shapes with usage errors", () => {
    expect(() => loadRecords(write("o.json", '{"a":1}'))).toThrow(/array of objects/);
    expect(() => loadRecords(write("n.json", "[1,2]"))).toThrow(/not an object/);
    expect(() => loadRecords(write("r.csv", "a,b\n1\n"))).toThrow(/row 2 has 1 fields/);
    expect(() => loadRecords(write("x.txt", "a"))).toThrow(/unsupported/);
  });

  it("derives filesystem-safe, unique keys", () => {
    expect(sanitizeKey("../Hello World/é!", "k")).toBe("Hello-World-e");
    expect(deriveKeys([{}, {}], undefined)).toEqual(["0", "1"]);
    expect(() => deriveKeys([{ s: "a b" }, { s: "a/b" }], "s")).toThrow(/both map to the key/);
  });

  it("finds the document UUID: a uuid JSON line wins, else the first UUID", () => {
    expect(findDocUuid(`log ${uuidFor(9)}\n{"uuid":"${uuidFor(1)}"}`)).toBe(uuidFor(1).toUpperCase());
    expect(findDocUuid(`made ${uuidFor(2)}`)).toBe(uuidFor(2).toUpperCase());
    expect(findDocUuid("nothing")).toBeUndefined();
  });
});

describe("batch validation (before connecting)", () => {
  it("a missing --key field in any record is exit 2 and never connects", async () => {
    const t = write("t.js", TEMPLATE);
    const d = write("d.json", JSON.stringify([{ slug: "a" }, { headline: "no slug" }]));
    const r = await runCommand(batch, [t, "--data", d, "--key", "slug"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("record 1 has no 'slug'");
    expect(server.sessionsOpened()).toBe(0);
  });

  it("refuses a generative template before connecting, and a closing one", async () => {
    const d = write("d.json", POSTS);
    const gen = write("gen.js", "doc.generateImage('x');\n");
    const r = await runCommand(batch, [gen, "--data", d]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("generateImage");
    expect(r.stdout).toContain("--allow-generative");
    const closing = write("close.js", "doc.close();\n");
    const r2 = await runCommand(batch, [closing, "--data", d]);
    expect(r2.code).toBe(1);
    expect(r2.stdout).toContain("--save-dir");
    expect(server.sessionsOpened()).toBe(0);
  });

  it("requires --data and a readable template", async () => {
    const t = write("t.js", TEMPLATE);
    expect((await runCommand(batch, [t])).code).toBe(2);
    expect((await runCommand(batch, [join(work, "nope.js"), "--data", "x.json"])).code).toBe(2);
    expect(server.sessionsOpened()).toBe(0);
  });

  it("an empty data set is a definitive empty state without connecting", async () => {
    const t = write("t.js", TEMPLATE);
    const d = write("e.json", "[]");
    const r = await runCommand(batch, [t, "--data", d]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("batch[0]{key,status,doc,ms,note}:");
    expect(r.stdout).toContain("summary: ok=0 failed=0 skipped=0");
    expect(server.sessionsOpened()).toBe(0);
  });

  it("rejects --out-dir / --save-dir outside the Desktop folder (exit 2) before running anything", async () => {
    stubApp();
    stubTemplate();
    const t = write("t.js", TEMPLATE);
    const d = write("d.json", POSTS);
    const r = await runCommand(batch, [t, "--data", d, "--out-dir", join(root, "elsewhere")]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("outside the Desktop folder");
    expect(scripts().some((s) => s.includes("TEMPLATE_MARK"))).toBe(false);
  });

  it("refuses a hidden --save-dir or --out-dir offline: exit 2, no connection", async () => {
    const t = write("t.js", TEMPLATE);
    const d = write("d.json", POSTS);
    const save = await runCommand(batch, [t, "--data", d, "--save-dir", join(desktop, ".af")]);
    expect(save.code).toBe(2);
    expect(save.stdout).toContain("--save-dir is inside a hidden folder or file ('.af')");
    const out = await runCommand(batch, [t, "--data", d, "--out-dir", join(desktop, ".out")]);
    expect(out.code).toBe(2);
    expect(out.stdout).toContain("--out-dir is inside a hidden folder or file ('.out')");
    expect(server.sessionsOpened()).toBe(0);
  });
});

describe("batch execution", () => {
  it("runs N records over ONE connection with ARGS, key, index, outDir/outBase and helpers", async () => {
    stubApp();
    stubTemplate();
    const t = write("t.js", TEMPLATE);
    const d = write("d.json", POSTS);
    const out = join(desktop, "out");
    const r = await runCommand(batch, [t, "--data", d, "--key", "slug", "--with-helpers", "--out-dir", out]);
    expect(r.code).toBe(0);
    expect(server.sessionsOpened()).toBe(1);
    expect(parseToon(r.stdout).ok).toBe(true);
    expect(r.stdout).toContain("batch[3]{key,status,doc,ms,note}:");
    expect(r.stdout).toContain("summary: ok=3 failed=0 skipped=0");
    expect(existsSync(out)).toBe(true);

    const runs = scripts().filter((s) => s.includes("TEMPLATE_MARK"));
    expect(runs).toHaveLength(3);
    expect(runs[1]).toContain("function axiDoc(");
    const a = argsOf(runs[1]!);
    expect(a).toMatchObject({ slug: "b", headline: "Dua", key: "b", index: 1, outDir: out, outBase: join(out, "b") });
  });

  it("without --key the record index names the record", async () => {
    stubTemplate();
    const r = await runCommand(batch, [write("t.js", TEMPLATE), "--data", write("d.json", POSTS)]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\n {2}0,ok,/);
    expect(r.stdout).toMatch(/\n {2}2,ok,/);
    const a = argsOf(scripts().filter((s) => s.includes("TEMPLATE_MARK"))[0]!);
    expect(a["outBase"]).toBeUndefined();
  });

  it("stops at the first failure by default and reports the rest as skipped (exit 1)", async () => {
    stubTemplate((a) => a["key"] === "b");
    const r = await runCommand(batch, [write("t.js", TEMPLATE), "--data", write("d.json", POSTS), "--key", "slug"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("summary: ok=1 failed=1 skipped=1");
    expect(r.stdout).toMatch(/\n {2}b,failed,,\d+,Error: boom b at main:3:1/);
    expect(r.stdout).toMatch(/\n {2}c,skipped,/);
    expect(r.stdout).toContain("--continue-on-error");
    expect(scripts().filter((s) => s.includes("TEMPLATE_MARK"))).toHaveLength(2);
  });

  it("--continue-on-error runs every record and still exits 1", async () => {
    stubTemplate((a) => a["key"] === "b");
    const r = await runCommand(batch, [write("t.js", TEMPLATE), "--data", write("d.json", POSTS), "--key", "slug", "--continue-on-error"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("summary: ok=2 failed=1 skipped=0");
    expect(scripts().filter((s) => s.includes("TEMPLATE_MARK"))).toHaveLength(3);
    expect(server.sessionsOpened()).toBe(1);
  });

  it("--limit processes only the first N records", async () => {
    stubTemplate();
    const r = await runCommand(batch, [write("t.js", TEMPLATE), "--data", write("d.json", POSTS), "--key", "slug", "--limit", "2"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("batch[2]{");
    expect(r.stdout).toContain("limited to 2 of 3 records");
    expect(scripts().filter((s) => s.includes("TEMPLATE_MARK"))).toHaveLength(2);
    expect((await runCommand(batch, [write("t.js", TEMPLATE), "--data", write("d.json", POSTS), "--limit", "0"])).code).toBe(2);
  });

  it("reads CSV data end to end", async () => {
    stubTemplate();
    const d = write("d.csv", 'slug,headline\na,"Halo, dunia"\nb,Dua\n');
    const r = await runCommand(batch, [write("t.js", TEMPLATE), "--data", d, "--key", "slug"]);
    expect(r.code).toBe(0);
    const runs = scripts().filter((s) => s.includes("TEMPLATE_MARK"));
    expect(argsOf(runs[0]!)["headline"]).toBe("Halo, dunia");
  });
});

describe("batch --save-dir", () => {
  it("per record: template, then save, then close (never close before save)", async () => {
    stubApp();
    stubTemplate();
    stubSaveClose();
    const af = join(desktop, "af");
    const r = await runCommand(batch, [write("t.js", TEMPLATE), "--data", write("d.json", POSTS), "--key", "slug", "--save-dir", af]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("summary: ok=3 failed=0 skipped=0");
    const kinds = scripts()
      .map((s) => (s.includes("TEMPLATE_MARK") ? "T" : s.includes("doc-save") ? "S" : s.includes("doc-close") ? "C" : ""))
      .filter(Boolean)
      .join("");
    expect(kinds).toBe("TSCTSCTSC");
    const saves = scripts().filter((s) => s.includes("doc-save"));
    expect(saves[0]).toContain(JSON.stringify(join(af, "a.af")));
    expect(saves[0]).toContain(JSON.stringify(uuidFor(1).toUpperCase()));
    expect(existsSync(join(af, "c.af"))).toBe(true);
    expect(scripts().filter((s) => s.includes("doc-close"))[0]).toContain("doc.isDirty");
    expect(server.sessionsOpened()).toBe(1);
  });

  describe("overwrite guard", () => {
    const run = (extra: string[] = []): ReturnType<typeof runCommand> =>
      runCommand(batch, [write("t.js", TEMPLATE), "--data", write("d.json", POSTS), "--key", "slug", "--save-dir", join(desktop, "af"), ...extra]);
    const preWrite = (): string => {
      mkdirSync(join(desktop, "af"), { recursive: true });
      const p = join(desktop, "af", "a.af");
      writeFileSync(p, "hand made");
      return p;
    };

    it("refuses an existing .af with no manifest: the row fails, the document is left open, the file is untouched", async () => {
      stubApp();
      stubTemplate();
      stubSaveClose();
      const a = preWrite();
      const r = await run();
      expect(r.code).toBe(1);
      expect(r.stdout).toContain("a,failed");
      expect(r.stdout).toContain("a.af exists and was not saved by affinity-axi (no manifest); refusing to overwrite");
      expect(r.stdout).toContain("--force");
      expect(r.stdout).toContain("b,skipped");
      expect(readFileSync(a, "utf8")).toBe("hand made");
      expect(scripts().some((s) => s.includes("doc-save") || s.includes("doc-close"))).toBe(false);
    });

    it("the row note is short and never carries the path; the help block has the --force line and the full doc open path", async () => {
      stubApp();
      stubTemplate();
      stubSaveClose();
      const folder = join(desktop, "a-folder-name-long-enough-to-push-the-old-note-well-past-two-hundred-characters", "af");
      mkdirSync(folder, { recursive: true });
      const a = join(folder, "a.af");
      writeFileSync(a, "hand made");
      const t = write("t.js", TEMPLATE);
      const d = write("d.json", POSTS);
      const r = await runCommand(batch, [t, "--data", d, "--key", "slug", "--save-dir", folder]);
      expect(r.code).toBe(1);
      expect(parseToon(r.stdout).ok).toBe(true);
      const rowLine = r.stdout.split("\n").find((l) => l.startsWith("  a,failed"))!;
      expect(rowLine).toContain("a.af exists and was not saved by affinity-axi (no manifest); refusing to overwrite (--force to replace); left open");
      expect(rowLine).not.toContain("doc open");
      expect(rowLine).not.toContain(folder);
      expect(rowLine.endsWith('"')).toBe(false);
      expect(r.stdout.split(`doc open ${a}`)).toHaveLength(2);
      expect(r.stdout).toContain(`batch ${t} --data ${d} --key slug --save-dir ${folder} --force   # replace the 1 refused .af: a.af`);
    });

    it("with several refused rows the help names them all but doc open names only the first", async () => {
      stubApp();
      stubTemplate();
      stubSaveClose();
      const a = preWrite();
      const b = join(desktop, "af", "b.af");
      writeFileSync(b, "hand made too");
      const r = await run(["--continue-on-error"]);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain("# replace the 2 refused .af: a.af, b.af");
      expect(r.stdout).toContain(`doc open ${a}`);
      expect(r.stdout).not.toContain(`doc open ${b}`);
    });

    it("a run with nothing refused adds no refusal lines", async () => {
      stubApp();
      stubTemplate();
      stubSaveClose();
      const r = await run();
      expect(r.code).toBe(0);
      expect(r.stdout).not.toContain("refused .af");
    });

    it("with --continue-on-error the other records still run", async () => {
      stubApp();
      stubTemplate();
      stubSaveClose();
      const a = preWrite();
      const r = await run(["--continue-on-error"]);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain("summary: ok=2 failed=1 skipped=0");
      expect(readFileSync(a, "utf8")).toBe("hand made");
      expect(existsSync(join(desktop, "af", "b.af"))).toBe(true);
      expect(existsSync(join(desktop, "af", "c.af"))).toBe(true);
    });

    it("--force replaces it, records forced: true in the manifest and --force in the run log", async () => {
      stubApp();
      stubTemplate();
      stubSaveClose();
      const a = preWrite();
      const r = await run(["--force"]);
      expect(r.code).toBe(0);
      expect(readFileSync(a, "utf8")).toBe("af");
      const m = readManifest(a)!;
      expect(m.history.at(-1)).toMatchObject({ kind: "save", forced: true });
      expect(readManifest(join(desktop, "af", "b.af"))!.history.at(-1)).not.toHaveProperty("forced");
      expect(readRuns(work)[0]!.flags).toContain("--force");
    });

    it("overwrites its own earlier output without a flag, and refuses it once hand-edited", async () => {
      stubApp();
      stubTemplate();
      stubSaveClose();
      expect((await run()).code).toBe(0);
      expect((await run()).code).toBe(0);
      const a = join(desktop, "af", "a.af");
      expect(readManifest(a)!.history.at(-1)).not.toHaveProperty("forced");
      writeFileSync(a, "hand edited");
      const r = await run();
      expect(r.code).toBe(1);
      expect(r.stdout).toContain("a.af was changed outside affinity-axi");
      expect(readFileSync(a, "utf8")).toBe("hand edited");
      expect((await run(["--force"])).code).toBe(0);
      expect(readManifest(a)!.history.at(-1)).toMatchObject({ kind: "save", forced: true });
    });
  });

  it("does not close a document that is still dirty after save", async () => {
    stubApp();
    stubTemplate();
    stubSaveClose({ dirtyAfterSave: true });
    const r = await runCommand(batch, [write("t.js", TEMPLATE), "--data", write("d.json", POSTS), "--key", "slug", "--save-dir", join(desktop, "af")]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("still dirty after save; left open");
    expect(scripts().some((s) => s.includes("doc-close"))).toBe(false);
  });

  it("does not save or close when the template failed", async () => {
    stubApp();
    stubTemplate(() => true);
    stubSaveClose();
    const r = await runCommand(batch, [write("t.js", TEMPLATE), "--data", write("d.json", POSTS), "--save-dir", join(desktop, "af")]);
    expect(r.code).toBe(1);
    expect(scripts().some((s) => s.includes("doc-save") || s.includes("doc-close"))).toBe(false);
  });

  it("fails the record (without closing) when the template reports no document UUID and none is current", async () => {
    stubApp();
    server.onScript("affinity-axi:list-documents", JSON.stringify({ current: null, documents: [] }));
    server.onScript("TEMPLATE_MARK", "done");
    stubSaveClose();
    const r = await runCommand(batch, [write("t.js", TEMPLATE), "--data", write("d.json", POSTS), "--save-dir", join(desktop, "af")]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("no document UUID");
    expect(scripts().some((s) => s.includes("doc-close"))).toBe(false);
  });
});

describe("batch generative provenance", () => {
  it("logs one provenance record per record with that record's args", async () => {
    stubTemplate();
    const gen = write("gen.js", "/* TEMPLATE_MARK */\nconst x = doc.generateImage(ARGS.headline);\n");
    const r = await runCommand(batch, [gen, "--data", write("d.json", POSTS), "--key", "slug", "--allow-generative"]);
    expect(r.code).toBe(0);
    const lines = readFileSync(join(work, ".affinity-axi", "provenance.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    const rec = JSON.parse(lines[1]!) as { args: { headline: string; key: string }; documents: string[]; identifiers: Array<{ identifier: string }> };
    expect(rec.args).toMatchObject({ headline: "Dua", key: "b" });
    expect(rec.documents).toEqual([uuidFor(2).toUpperCase()]);
    expect(rec.identifiers[0]!.identifier).toBe("generateImage");
  });
});

describe("batch reserved record fields and number flags", () => {
  it("warns once, after summary, when a record field is replaced in ARGS; the batch value still wins", async () => {
    stubTemplate();
    const d = write("d.json", JSON.stringify([{ slug: "a", key: "x", outBase: 1 }]));
    const r = await runCommand(batch, [write("t.js", TEMPLATE), "--data", d, "--key", "slug"]);
    expect(r.code).toBe(0);
    expect(parseToon(r.stdout).ok).toBe(true);
    const lines = r.stdout.split("\n");
    const w = lines.filter((l) => l.startsWith("warning:"));
    expect(w).toEqual(["warning: record fields key, outBase are replaced in ARGS by the batch values (key, index, outDir, outBase); rename them in the data file"]);
    const at = lines.indexOf(w[0]!);
    expect(lines[at - 1]).toMatch(/^summary: /);
    expect(argsOf(scripts().find((s) => s.includes("TEMPLATE_MARK"))!)["key"]).toBe("a");
  });

  it("a single reserved field reads in the singular", async () => {
    stubTemplate();
    const d = write("d.json", JSON.stringify([{ slug: "a", index: 5 }]));
    const r = await runCommand(batch, [write("t.js", TEMPLATE), "--data", d, "--key", "slug"]);
    expect(r.stdout).toContain("warning: record field index is replaced in ARGS");
  });

  it("no reserved field means no warning line and the help block is unchanged", async () => {
    stubTemplate();
    const r = await runCommand(batch, [write("t.js", TEMPLATE), "--data", write("d.json", POSTS), "--key", "slug"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("warning:");
    expect(r.stdout).toMatch(/\nhelp\[2\]:/);
  });

  it("--timeout and --limit take one strict positive whole number: 1e3 and 0x2 are usage errors with no connection", async () => {
    const t = write("t.js", TEMPLATE);
    const d = write("d.json", POSTS);
    const a = await runCommand(batch, [t, "--data", d, "--timeout", "1e3"]);
    expect(a.code).toBe(2);
    expect(a.stdout).toContain("invalid --timeout '1e3'");
    const b = await runCommand(batch, [t, "--data", d, "--limit", "0x2"]);
    expect(b.code).toBe(2);
    expect(b.stdout).toContain("invalid --limit '0x2'");
    expect(server.sessionsOpened()).toBe(0);
  });
});
