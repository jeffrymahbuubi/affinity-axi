// `batch` row notes and left-open documents: notes join with "; ", and a failed record that left a
// document open is named (diff against the listing taken at the start of the run). Fake MCP server.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { joinNotes, leftOpenNote, make, strayDocs } from "../src/commands/batch.js";
import { listDocs, type DocListing } from "../src/commands/run.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_APP, FIXTURE_DOCS } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

const U1 = "00000000-0000-4000-8000-000000000001";
const U2 = "00000000-0000-4000-8000-000000000002";
const doc = (uuid: string, dirty: boolean, path = ""): DocListing["documents"][number] => ({ uuid, path, dirty });
const listing = (...documents: DocListing["documents"]): DocListing => ({ current: documents[0]?.uuid ?? null, documents });

describe("batch note helpers", () => {
  it("joinNotes drops empty parts and joins with a semicolon", () => {
    expect(joinNotes(["a", "", "b"])).toBe("a; b");
    expect(joinNotes([])).toBe("");
  });

  it("strayDocs: null listing, known clean, unknown, known dirty reported, known dirty unreported", () => {
    expect(strayDocs(new Set(), null)).toEqual([]);
    const clean = doc(U1, false, "/d/a.af");
    expect(strayDocs(new Set([U1]), listing(clean))).toEqual([]);
    expect(strayDocs(new Set(), listing(clean))).toEqual([clean]);
    const dirty = doc(U1, true);
    expect(strayDocs(new Set([U1]), listing(dirty), U1)).toEqual([dirty]);
    expect(strayDocs(new Set([U1, U2]), listing(dirty, doc(U2, true)))).toEqual([]);
    expect(strayDocs(new Set([U1]), listing(dirty), U1.toLowerCase())).toEqual([dirty]);
  });

  it("leftOpenNote: unsaved, unsaved changes in a file, clean file", () => {
    expect(leftOpenNote(doc("6681ED67-0000-4000-8000-000000000000", true))).toBe("left open: 6681ED67 (unsaved)");
    expect(leftOpenNote(doc("6681ed67-0000-4000-8000-000000000000", true, "/home/x/Desktop/af/welcome.af"))).toBe("left open: 6681ED67 (unsaved changes in welcome.af)");
    expect(leftOpenNote(doc("6681ED67-0000-4000-8000-000000000000", false, "C:\\Users\\x\\welcome.af"))).toBe("left open: 6681ED67 (welcome.af)");
  });
});

describe("batch left-open reporting", () => {
  let server: FakeServer;
  let root: string;
  let work: string;
  let desktop: string;
  const origCwd = process.cwd();
  const origUrl = process.env["AFFINITY_MCP_URL"];
  const origPath = process.env["PATH"];
  const origBrand = process.env["AFFINITY_AXI_BRAND"];
  const batch = make(fakeConnect());

  beforeEach(async () => {
    server = await startFakeServer();
    process.env["AFFINITY_MCP_URL"] = server.url;
    delete process.env["AFFINITY_AXI_BRAND"];
    root = mkdtempSync(join(tmpdir(), "axi-batch-find-"));
    work = join(root, "work");
    desktop = join(root, "Desktop");
    mkdirSync(work);
    mkdirSync(desktop);
    process.chdir(work);
  });

  afterEach(async () => {
    process.chdir(origCwd);
    process.env["PATH"] = origPath;
    if (origUrl === undefined) delete process.env["AFFINITY_MCP_URL"];
    else process.env["AFFINITY_MCP_URL"] = origUrl;
    if (origBrand === undefined) delete process.env["AFFINITY_AXI_BRAND"];
    else process.env["AFFINITY_AXI_BRAND"] = origBrand;
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  const write = (name: string, body: string): string => {
    const p = join(work, name);
    writeFileSync(p, body);
    return p;
  };
  const scripts = (): string[] => server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"]));
  const argsOf = (script: string): Record<string, unknown> => JSON.parse(/const ARGS = (.*?); /.exec(script)![1]!) as Record<string, unknown>;
  const TEMPLATE = "/* TEMPLATE_MARK */\nconst d = axiDoc(10, 10);\nconsole.log(JSON.stringify({uuid: String(d.sessionUuid)}));\n";
  const POSTS = JSON.stringify([{ slug: "a" }, { slug: "b" }]);
  const run = (extra: string[] = []): ReturnType<typeof runCommand> => runCommand(batch, [write("t.js", TEMPLATE), "--data", write("d.json", POSTS), "--key", "slug", ...extra]);

  /** Every record throws; the output may name a document first (`logUuid`). */
  function stubThrowing(logUuid?: (n: number) => string): void {
    let n = 0;
    server.onScript("TEMPLATE_MARK", () => {
      n++;
      return `${logUuid ? JSON.stringify({ uuid: logUuid(n) }) + "\n" : ""}building...\nError: boom\n    at main:3:1`;
    });
  }

  /** list-documents replies: call 1 is the start listing, call k the (k-1)th read after a record. */
  function stubListing(byCall: (call: number) => DocListing["documents"]): void {
    let n = 0;
    server.onScript("affinity-axi:list-documents", () => {
      const documents = byCall(++n);
      return JSON.stringify({ current: documents[0]?.uuid ?? null, documents });
    });
  }

  function stubOk(): void {
    let n = 0;
    server.onScript("TEMPLATE_MARK", (script) => JSON.stringify({ uuid: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, key: argsOf(script)["key"] }));
  }

  it("a template that throws before it logs a UUID: the stray document is named, fills the doc column, and ends the run with leftOpen", async () => {
    stubThrowing();
    stubListing((call) => (call === 1 ? [] : [doc(U1, true)]));
    const r = await run();
    expect(r.code).toBe(1);
    const row = r.stdout.split("\n").find((l) => l.startsWith("  a,failed"))!;
    expect(row).toContain(`a,failed,${U1.slice(0, 8)},`);
    expect(row).toContain("Error: boom at main:3:1; left open: 00000000 (unsaved)");
    expect(r.stdout).toContain(`leftOpen: ${U1}`);
    expect(r.stdout).toContain("doc save <doc> <path-under-Desktop>.af");
    expect(scripts().some((s) => s.includes("doc-save") || s.includes("doc-close"))).toBe(false);
  });

  it("a document that was open before the batch is not reported", async () => {
    stubThrowing();
    stubListing(() => [doc(U1, true)]);
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain("left open");
    expect(r.stdout).not.toContain("leftOpen:");
    expect(r.stdout).toMatch(/\n {2}a,failed,,\d+,Error: boom at main:3:1\n/);
  });

  it("a failed record that did log its UUID: a new dirty document is reported", async () => {
    stubThrowing(() => U1);
    stubListing((call) => (call === 1 ? [] : [doc(U1, true)]));
    const r = await run();
    expect(r.stdout).toContain(`a,failed,${U1.slice(0, 8)},`);
    expect(r.stdout).toContain("; left open: 00000000 (unsaved)");
    expect(r.stdout).toContain(`leftOpen: ${U1}`);
  });

  it("a reported document that was listed clean at the start is not named", async () => {
    stubThrowing(() => U1);
    stubListing(() => [doc(U1, false, "/d/a.af")]);
    const r = await run();
    expect(r.stdout).not.toContain("left open");
    expect(r.stdout).not.toContain("leftOpen:");
  });

  it("--continue-on-error: each failed record names its own stray and leftOpen lists both once", async () => {
    stubThrowing();
    stubListing((call) => [doc(U1, true), doc(U2, true)].slice(0, call - 1));
    const r = await run(["--continue-on-error"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("summary: ok=0 failed=2 skipped=0");
    expect(r.stdout).toContain(`a,failed,${U1.slice(0, 8)},`);
    expect(r.stdout).toContain(`b,failed,${U2.slice(0, 8)},`);
    expect(r.stdout.match(/left open: 00000000 \(unsaved\)/g)).toHaveLength(2);
    expect(r.stdout).toContain(`leftOpen: ${U1} ${U2}\n`);
  });

  it("a refused overwrite feeds the leftOpen line", async () => {
    stubOk();
    server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
    const af = join(desktop, "af");
    mkdirSync(af, { recursive: true });
    writeFileSync(join(af, "a.af"), "hand made");
    const r = await run(["--save-dir", af]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("refusing to overwrite (--force to replace); left open");
    expect(r.stdout).toContain(`leftOpen: ${U1}\n`);
    expect(r.stdout).toContain("doc save <doc> <path-under-Desktop>.af");
  });

  it("an ok record produces no leftOpen line", async () => {
    stubOk();
    stubListing(() => []);
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("leftOpen:");
  });

  it("the ok note joins parts with a semicolon: saved ..., closed; metadata: ...", async () => {
    const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunk = (type: string, data: Buffer): Buffer => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(data.length, 0);
      head.write(type, 4, "latin1");
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
      return Buffer.concat([head, data, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(100, 0);
    ihdr.writeUInt32BE(50, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const xmp = "XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta><dc:creator><rdf:Seq><rdf:li>account-handle</rdf:li></rdf:Seq></dc:creator></x:xmpmeta>";
    const png = Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("iTXt", Buffer.from(xmp)), chunk("IDAT", Buffer.from([1, 2, 3, 4])), chunk("IEND", Buffer.alloc(0))]);
    // A fake exiftool so the kit credit is embedded.
    const bin = join(root, "bin");
    mkdirSync(bin);
    const tool = join(bin, "exiftool");
    writeFileSync(tool, '#!/bin/sh\nif [ "$1" = "-ver" ]; then echo 13.55; exit 0; fi\nexit 0\n');
    chmodSync(tool, 0o755);
    process.env["PATH"] = `${bin}:/usr/bin:/bin`;
    const kit = JSON.parse(readFileSync(join(origCwd, "examples/_brand/brand.json"), "utf8")) as Record<string, unknown>;
    write("brand.json", JSON.stringify({ ...kit, credit: { creator: "Studio X" } }));

    let n = 0;
    server.onScript("TEMPLATE_MARK", (script) => {
      const args = argsOf(script);
      writeFileSync(`${String(args["outBase"])}.png`, png);
      return JSON.stringify({ uuid: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` });
    });
    server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
    server.onScript("affinity-axi:doc-save", (script) => {
      const path = JSON.parse(/const outPath = (".*");/.exec(script)![1]!) as string;
      writeFileSync(path, "af");
      return JSON.stringify({ status: "saved", uuid: "x", path, dirty: false });
    });
    server.onScript("affinity-axi:doc-close", JSON.stringify({ status: "closed", uuid: "x" }));
    const r = await run(["--out-dir", join(desktop, "out"), "--save-dir", join(desktop, "af"), "--brand", join(work, "brand.json")]);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/, closed; metadata: /);
    expect(r.stdout).not.toContain("closed metadata");
    expect(r.stdout).not.toContain("leftOpen:");
  });

  it("listDocs maps the dirty flag from the listing", async () => {
    server.onScript("affinity-axi:list-documents", JSON.stringify({ current: FIXTURE_DOCS[0]!.uuid, documents: FIXTURE_DOCS }));
    const client = await fakeConnect()({ url: server.url });
    try {
      const l = await listDocs(client);
      expect(l?.documents.map((d) => d.dirty)).toEqual(FIXTURE_DOCS.map((d) => d.dirty === true));
      expect(l?.documents[0]).toMatchObject({ uuid: FIXTURE_DOCS[0]!.uuid, dirty: true });
    } finally {
      client.close();
    }
  });
});
