// `fill`: slot planning, validation before connecting, one connection for N
// records, script order per record, failure handling, save+close ordering,
// manifest and run log. Fake MCP server; no Affinity.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { make } from "../src/commands/fill.js";
import { type ApplyReply } from "../src/affinity/fill-script.js";
import { dispatch } from "../src/cli/router.js";
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
  root = mkdtempSync(join(tmpdir(), "axi-fill-"));
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

const fill = make(fakeConnect());

function write(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

const POSTS = JSON.stringify([
  { slug: "mar", headline: "Spring", price: "49" },
  { slug: "apr", headline: "April", price: "59" },
]);
const OK_REPLY: ApplyReply = { applied: ["headline", "price"], unknown: [], duplicate: [], mismatch: [], slots: ["slot:headline", "slot:price", "slot:photo", "slot:cta"] };
const uuidFor = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scripts = (): string[] => server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"]));
const markers = (): string[] =>
  scripts()
    .map((s) => /affinity-axi:([a-z-]+)/.exec(s)?.[1] ?? "?")
    .filter((m) => m !== "app-info");
const quoted = (script: string, name: string): string => JSON.parse(new RegExp(`const ${name} = (".*");`).exec(script)![1]!) as string;

interface Stubs {
  apply?: (n: number) => ApplyReply | string;
  open?: (n: number) => string;
  close?: (n: number) => string;
  dirtyAfterSave?: boolean;
  failExport?: boolean;
  artboards?: string[];
}

/** Stubs the whole fill pipeline; `n` is the 1-based record counter. */
function stub(o: Stubs = {}): { opened: () => number } {
  let opens = 0;
  let applies = 0;
  let closes = 0;
  server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
  server.onScript("affinity-axi:list-presets", JSON.stringify(["PNG", "JPEG (High quality)", "SVG (digital - small size)"]));
  server.onScript("affinity-axi:fill-open", () => (o.open ? o.open(++opens) : JSON.stringify({ status: "loaded", uuid: uuidFor(++opens) })));
  server.onScript("affinity-axi:fill-apply", () => {
    const r = o.apply ? o.apply(++applies) : OK_REPLY;
    return typeof r === "string" ? r : JSON.stringify(r);
  });
  server.onScript("affinity-axi:doc-save", (script) => {
    const path = quoted(script, "outPath");
    writeFileSync(path, `af:${path}`);
    return JSON.stringify({ status: "saved", uuid: "x", path, dirty: o.dirtyAfterSave === true });
  });
  server.onScript("affinity-axi:doc-close", () => (o.close ? o.close(++closes) : JSON.stringify({ status: "closed", uuid: "x" })));
  server.onScript("affinity-axi:list-artboards", JSON.stringify({ spreads: 1, artboards: (o.artboards ?? ["ig-square", "story"]).map((name, index) => ({ index, name })) }));
  const exporter = (script: string): string => {
    if (o.failExport) return "Error: preset cannot export this\n    at main:3:1";
    const path = quoted(script, "outPath");
    writeFileSync(path, "img");
    return JSON.stringify({ exported: path });
  };
  server.onScript("affinity-axi:export", exporter);
  server.onScript("affinity-axi:area-export", exporter);
  return { opened: () => opens };
}

function setup(): { template: string; data: string; out: string } {
  const template = write(desktop, "post.af", "template");
  const data = write(work, "posts.json", POSTS);
  return { template, data, out: join(desktop, "out") };
}

describe("fill validation (before connecting)", () => {
  it("--help, missing --data, missing --out-dir, bad template make zero connections", async () => {
    const { template, data, out } = setup();
    const root0 = { spec: { name: "root", summary: "r", args: [], flags: [], examples: [] }, run: () => 0 };
    const reg = { tool: "affinity-axi", root: root0, rootHelp: () => "", commands: { fill }, aliases: {} };
    const chunks: string[] = [];
    const w = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => (chunks.push(String(s)), true)) as typeof process.stdout.write;
    let code: number;
    try {
      code = await dispatch(reg, ["fill", "--help"]);
    } finally {
      process.stdout.write = w;
    }
    expect(code).toBe(0);
    expect(chunks.join("")).toContain("--out-dir");

    expect((await runCommand(fill, [template, "--out-dir", out])).code).toBe(2);
    expect((await runCommand(fill, [template, "--data", data])).code).toBe(2);
    expect((await runCommand(fill, [join(work, "nope.af"), "--data", data, "--out-dir", out])).code).toBe(2);
    write(work, "t.txt", "x");
    expect((await runCommand(fill, [join(work, "t.txt"), "--data", data, "--out-dir", out])).code).toBe(2);
    expect(server.sessionsOpened()).toBe(0);
  });

  it("--all-artboards without --export, a bad --limit, a missing --key field and bad values are exit 2", async () => {
    const { template, data, out } = setup();
    expect((await runCommand(fill, [template, "--data", data, "--out-dir", out, "--all-artboards"])).code).toBe(2);
    expect((await runCommand(fill, [template, "--data", data, "--out-dir", out, "--limit", "0"])).code).toBe(2);
    expect((await runCommand(fill, [template, "--data", data, "--out-dir", out, "--key", "nope"])).code).toBe(2);
    const bad = write(work, "bad.json", JSON.stringify([{ slug: "a", price: null }]));
    const r = await runCommand(fill, [template, "--data", bad, "--out-dir", out, "--key", "slug"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("slot 'price': unsupported value");
    expect((await runCommand(fill, [template, "--data", data, "--out-dir", out, "--export", "Canva Design"])).code).toBe(2);
    expect(server.sessionsOpened()).toBe(0);
  });

  it("an empty data set prints an empty table without connecting", async () => {
    const { template, out } = setup();
    const empty = write(work, "e.json", "[]");
    const r = await runCommand(fill, [template, "--data", empty, "--out-dir", out]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("records[0]{key,status,doc,ms,note}:");
    expect(server.sessionsOpened()).toBe(0);
  });

  it("rejects an --out-dir or an image outside the Desktop before any fill script", async () => {
    stub();
    const { template, data } = setup();
    const r = await runCommand(fill, [template, "--data", data, "--out-dir", join(root, "elsewhere")]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("outside the Desktop folder");
    write(work, "photo.png", "png");
    const withImg = write(work, "img.json", JSON.stringify([{ slug: "a", photo: "photo.png" }]));
    const r2 = await runCommand(fill, [template, "--data", withImg, "--key", "slug", "--out-dir", join(desktop, "out")]);
    expect(r2.code).toBe(2);
    expect(r2.stdout).toContain("image is outside the Desktop folder");
    expect(markers().some((m) => m.startsWith("fill-"))).toBe(false);
  });

  it("refuses a hidden --out-dir, a hidden image and a hidden template offline, before any session", async () => {
    stub();
    const { template, data } = setup();
    const a = await runCommand(fill, [template, "--data", data, "--out-dir", join(desktop, ".out")]);
    expect(a.code).toBe(2);
    expect(a.stdout).toContain("--out-dir is inside a hidden folder or file ('.out')");

    mkdirSync(join(work, ".img"));
    write(join(work, ".img"), "a.png", "png");
    const withImg = write(work, "hid.json", JSON.stringify([{ slug: "a", photo: ".img/a.png" }]));
    const b = await runCommand(fill, [template, "--data", withImg, "--key", "slug", "--out-dir", join(desktop, "out")]);
    expect(b.code).toBe(2);
    expect(b.stdout).toContain("image is inside a hidden folder or file ('.img')");

    mkdirSync(join(desktop, ".tpl"));
    const hiddenTpl = write(join(desktop, ".tpl"), "t.af", "template");
    const c = await runCommand(fill, [hiddenTpl, "--data", data, "--out-dir", join(desktop, "out")]);
    expect(c.code).toBe(2);
    expect(c.stdout).toContain("template is inside a hidden folder or file ('.tpl')");

    const empty = write(work, "none.json", "[]");
    const d = await runCommand(fill, [template, "--data", empty, "--out-dir", join(desktop, ".out")]);
    expect(d.code).toBe(2);
    expect(server.sessionsOpened()).toBe(0);
  });

  it("refuses a template outside the Desktop folder (Affinity can only open files under it)", async () => {
    stub();
    const { data, out } = setup();
    const outside = write(work, "elsewhere.af", "template");
    const r = await runCommand(fill, [outside, "--data", data, "--out-dir", out]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("template is outside the Desktop folder");
    expect(r.stdout).toContain("can only open files under");
    expect(markers().some((m) => m.startsWith("fill-"))).toBe(false);
  });

  it("an unknown preset is exit 2 with the closest names", async () => {
    stub();
    const { template, data, out } = setup();
    const r = await runCommand(fill, [template, "--data", data, "--out-dir", out, "--export", "PNG-X"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("unknown export preset 'PNG-X'");
    expect(markers().some((m) => m.startsWith("fill-"))).toBe(false);
  });
});

describe("fill execution", () => {
  it("two records: open, apply, save, export, close per record over ONE connection", async () => {
    stub();
    const { template, data, out } = setup();
    const r = await runCommand(fill, [template, "--data", data, "--key", "slug", "--out-dir", out, "--export", "PNG"]);
    expect(r.code).toBe(0);
    expect(server.sessionsOpened()).toBe(1);
    expect(parseToon(r.stdout).ok).toBe(true);
    expect(r.stdout).toContain("records[2]{key,status,doc,ms,note}:");
    expect(r.stdout).toContain("mar,ok,00000000,");
    expect(r.stdout).toContain("saved mar.af; exported mar.png");
    expect(r.stdout).toContain(`saved: ${out}`);
    expect(r.stdout).toContain("exported: 2");
    expect(markers()).toEqual([
      "list-presets",
      "fill-open", "fill-apply", "doc-save", "export", "doc-close",
      "fill-open", "fill-apply", "doc-save", "export", "doc-close",
    ]);
    for (const f of ["mar.af", "apr.af", "mar.png", "apr.png"]) expect(existsSync(join(out, f))).toBe(true);
    expect(quoted(scripts().find((s) => s.includes("fill-open"))!, "target")).toBe(template);
    const apply = scripts().find((s) => s.includes("fill-apply"))!;
    expect(apply).toContain("slot:headline");
    expect(apply).toContain("slot:price");
    expect(apply).not.toMatch(/"ref":"headline"/);
    expect(apply).not.toContain('"ref":"slug"');
    expect(apply).toContain("function axiSetText(");
    expect(scripts().filter((s) => s.includes("fill-open") && s.includes("Document.load("))).toHaveLength(2);
    expect(scripts().filter((s) => s.includes("doc-save") && s.includes(".saveAs("))).toHaveLength(2);
  });

  it("without --export it saves and closes only; the help block points at doc open", async () => {
    stub();
    const { template, data, out } = setup();
    const r = await runCommand(fill, [template, "--data", data, "--key", "slug", "--out-dir", out]);
    expect(r.code).toBe(0);
    expect(markers()).toEqual(["fill-open", "fill-apply", "doc-save", "doc-close", "fill-open", "fill-apply", "doc-save", "doc-close"]);
    expect(r.stdout).toContain("exported: 0");
    expect(r.stdout).toContain(`doc open ${join(out, "mar.af")}`);
  });

  it("--all-artboards writes <key>-<artboard>.<ext> per artboard", async () => {
    stub({ artboards: ["ig-square", "story"] });
    const { template, data, out } = setup();
    const r = await runCommand(fill, [template, "--data", data, "--key", "slug", "--out-dir", out, "--export", "PNG", "--all-artboards", "--limit", "1"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("exported 2 files");
    expect(r.stdout).toContain("exported: 2");
    expect(existsSync(join(out, "mar-ig-square.png"))).toBe(true);
    expect(existsSync(join(out, "mar-story.png"))).toBe(true);
    expect(markers().filter((m) => m === "area-export")).toHaveLength(2);
  });

  it("a key story/headline produces the ref story/slot:headline", async () => {
    stub();
    const { template, out } = setup();
    const d = write(work, "q.json", JSON.stringify([{ slug: "a", "story/headline": "Hi" }]));
    const r = await runCommand(fill, [template, "--data", d, "--key", "slug", "--out-dir", out]);
    expect(r.code).toBe(0);
    expect(scripts().find((s) => s.includes("fill-apply"))).toContain('"ref":"story/slot:headline"');
  });

  it("already-open fails the record with the suggestion and makes no apply, save or close", async () => {
    stub({ open: () => JSON.stringify({ status: "already-open", uuid: uuidFor(5) }) });
    const { template, data, out } = setup();
    const r = await runCommand(fill, [template, "--data", data, "--key", "slug", "--out-dir", out]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("already open in Affinity");
    expect(r.stdout).toContain("doc save and doc close");
    expect(markers()).toEqual(["fill-open"]);
    expect(r.stdout).toContain("apr,skipped");
  });

  it("an unknown slot fails the record with the slot list and closes the clean document; no save", async () => {
    stub({ apply: () => ({ ...OK_REPLY, applied: [], unknown: ["subtitle"] }) });
    const { template, out } = setup();
    const d = write(work, "u.json", JSON.stringify([{ slug: "a", subtitle: "x" }]));
    const r = await runCommand(fill, [template, "--data", d, "--key", "slug", "--out-dir", out]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("unknown slot 'subtitle' (slots: headline, price, photo, cta)");
    expect(markers()).toEqual(["fill-open", "fill-apply", "doc-close"]);
    expect(existsSync(join(out, "a.af"))).toBe(false);
  });

  it("--ignore-unknown passes the flag to the script and the record proceeds", async () => {
    stub({ apply: () => ({ ...OK_REPLY, applied: ["headline"], unknown: ["subtitle"] }) });
    const { template, out } = setup();
    const d = write(work, "u.json", JSON.stringify([{ slug: "a", headline: "Hi", subtitle: "x" }]));
    const r = await runCommand(fill, [template, "--data", d, "--key", "slug", "--out-dir", out, "--ignore-unknown"]);
    expect(r.code).toBe(0);
    expect(scripts().find((s) => s.includes("fill-apply"))).toContain("const ignoreUnknown = true;");
    expect(r.stdout).toContain("ignored unknown slot: subtitle");
    expect(existsSync(join(out, "a.af"))).toBe(true);
  });

  it("a duplicate slot fails even with --ignore-unknown, naming the paths", async () => {
    stub({ apply: () => ({ ...OK_REPLY, applied: [], duplicate: [{ key: "price", paths: ["#0/0/3", "#0/1/3"] }] }) });
    const { template, data, out } = setup();
    const r = await runCommand(fill, [template, "--data", data, "--key", "slug", "--out-dir", out, "--ignore-unknown"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("duplicate slot 'price' at #0/0/3, #0/1/3");
    expect(markers()).toEqual(["fill-open", "fill-apply", "doc-close"]);
  });

  it("a mismatch fails the record and --continue-on-error goes on to the next", async () => {
    stub({ apply: (n) => (n === 1 ? { ...OK_REPLY, applied: [], mismatch: [{ key: "headline", node: "text node", got: "an image" }] } : OK_REPLY) });
    const { template, data, out } = setup();
    const r = await runCommand(fill, [template, "--data", data, "--key", "slug", "--out-dir", out, "--continue-on-error"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("slot 'headline' is a text node; got an image");
    expect(r.stdout).toContain("apr,ok");
    expect(existsSync(join(out, "mar.af"))).toBe(false);
    expect(existsSync(join(out, "apr.af"))).toBe(true);
  });

  it("stops at the first failure by default; later records are skipped", async () => {
    stub({ apply: () => ({ ...OK_REPLY, applied: [], unknown: ["x"] }) });
    const { template, data, out } = setup();
    const r = await runCommand(fill, [template, "--data", data, "--key", "slug", "--out-dir", out]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("apr,skipped");
    expect(r.stdout).toContain("--continue-on-error");
  });

  it("an apply exception on a document that is now dirty stops the run and reports leftOpen", async () => {
    stub({ apply: () => "Error: boom\n    at main:3:1", close: () => JSON.stringify({ status: "dirty", uuid: "x" }) });
    const { template, data, out } = setup();
    const r = await runCommand(fill, [template, "--data", data, "--key", "slug", "--out-dir", out, "--continue-on-error"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`leftOpen: ${uuidFor(1).toUpperCase()}`);
    expect(r.stdout).toMatch(/boom.*has unsaved changes/);
    expect(r.stdout).toContain("apr,skipped");
    expect(markers().filter((m) => m === "fill-open")).toHaveLength(1);
  });

  it("a dirty close reply after a good save stops the run with leftOpen", async () => {
    stub({ close: () => JSON.stringify({ status: "dirty", uuid: "x" }) });
    const { template, data, out } = setup();
    const r = await runCommand(fill, [template, "--data", data, "--key", "slug", "--out-dir", out]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("leftOpen:");
    expect(r.stdout).toContain("apr,skipped");
  });

  it("a document still dirty after saveAs is never closed", async () => {
    stub({ dirtyAfterSave: true });
    const { template, data, out } = setup();
    const r = await runCommand(fill, [template, "--data", data, "--key", "slug", "--out-dir", out]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("still dirty after save");
    expect(markers()).not.toContain("doc-close");
  });

  it("an export failure fails the record but still closes the saved document", async () => {
    stub({ failExport: true });
    const { template, data, out } = setup();
    const r = await runCommand(fill, [template, "--data", data, "--key", "slug", "--out-dir", out, "--export", "PNG", "--limit", "1"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("export of mar.png failed");
    expect(markers().slice(-2)).toEqual(["export", "doc-close"]);
  });

  it("never overwrites a hand-edited .af (stale manifest): the record fails before anything is opened", async () => {
    stub();
    const { template, data, out } = setup();
    const af = join(out, "mar.af");
    const r1 = await runCommand(fill, [template, "--data", data, "--key", "slug", "--out-dir", out, "--limit", "1"]);
    expect(r1.code).toBe(0);
    writeFileSync(af, "hand edited");
    server.calls.length = 0;
    const r2 = await runCommand(fill, [template, "--data", data, "--key", "slug", "--out-dir", out, "--limit", "1"]);
    expect(r2.code).toBe(1);
    expect(r2.stdout).toContain("changed outside affinity-axi");
    expect(markers()).toEqual([]);
    expect(readFileSync(af, "utf8")).toBe("hand edited");
  });

  it("--force overwrites a hand-edited .af and records forced: true", async () => {
    stub();
    const { template, data, out } = setup();
    const af = join(out, "mar.af");
    const args = [template, "--data", data, "--key", "slug", "--out-dir", out, "--limit", "1"];
    expect((await runCommand(fill, args)).code).toBe(0);
    writeFileSync(af, "hand edited");
    const r = await runCommand(fill, [...args, "--force"]);
    expect(r.code).toBe(0);
    expect(readFileSync(af, "utf8")).toBe(`af:${af}`);
    expect(readManifest(af)!.history.at(-1)).toMatchObject({ kind: "save", forced: true });
    expect(readManifest(af)!.madeBy?.flags).toContain("--force");
  });

  describe("an existing .af that affinity-axi never saved (no manifest)", () => {
    const args = (t: string, d: string, o: string, extra: string[] = []): string[] => [t, "--data", d, "--key", "slug", "--out-dir", o, ...extra];

    it("fails the record before anything is opened and leaves the file alone", async () => {
      stub();
      const { template, data, out } = setup();
      mkdirSync(out, { recursive: true });
      const af = write(out, "mar.af", "hand made");
      const r = await runCommand(fill, args(template, data, out, ["--limit", "1"]));
      expect(r.code).toBe(1);
      expect(r.stdout).toContain("mar.af exists and was not saved by affinity-axi (no manifest); refusing to overwrite");
      expect(r.stdout).toContain("--force");
      expect(markers()).toEqual([]);
      expect(readFileSync(af, "utf8")).toBe("hand made");
    });

    it("--force replaces it: forced: true in the manifest, --force in the run log flags", async () => {
      stub();
      const { template, data, out } = setup();
      mkdirSync(out, { recursive: true });
      const af = write(out, "mar.af", "hand made");
      const r = await runCommand(fill, args(template, data, out, ["--limit", "1", "--force"]));
      expect(r.code).toBe(0);
      expect(readFileSync(af, "utf8")).toBe(`af:${af}`);
      expect(readManifest(af)!.history.at(-1)).toMatchObject({ kind: "save", forced: true });
      expect(readRuns(work)[0]!.flags).toContain("--force");
    });

    it("regenerating its own fresh output needs no flag", async () => {
      stub();
      const { template, data, out } = setup();
      expect((await runCommand(fill, args(template, data, out, ["--limit", "1"]))).code).toBe(0);
      expect((await runCommand(fill, args(template, data, out, ["--limit", "1"]))).code).toBe(0);
      expect(readManifest(join(out, "mar.af"))!.history.at(-1)).not.toHaveProperty("forced");
    });
  });

  it("the run log and madeBy carry the sha256 of the template bytes", async () => {
    stub();
    const { template, data, out } = setup();
    const want = createHash("sha256").update(readFileSync(template)).digest("hex");
    const r = await runCommand(fill, [template, "--data", data, "--key", "slug", "--out-dir", out, "--limit", "1"]);
    expect(r.code).toBe(0);
    expect(readRuns(work)[0]!.scriptSha256).toBe(want);
    const m = readManifest(join(out, "mar.af"))!;
    expect(m.madeBy?.scriptSha256).toBe(want);
    expect(m.history.find((h) => h.kind === "fill")?.scriptSha256).toBe(want);
  });

  it("ML options: cutout reaches the apply script, a CSV cell requests none, a bad option is exit 2 with zero connections", async () => {
    stub();
    const { template, out } = setup();
    write(desktop, "photo.png", "png");
    const run = (name: string, body: string) => runCommand(fill, [template, "--data", write(desktop, name, body), "--key", "slug", "--out-dir", out]);
    const bad = await run("b.json", JSON.stringify([{ slug: "a", photo: { image: "photo.png", cutout: "magic" } }]));
    expect([bad.code, server.sessionsOpened(), bad.stdout.includes("cutout must be true, false, 'background' or 'subject'")]).toEqual([2, 0, true]);
    expect((await run("ml.json", JSON.stringify([{ slug: "a", photo: { image: "photo.png", cutout: true } }]))).code).toBe(0);
    expect(markers()).toEqual(["fill-open", "fill-apply", "doc-save", "doc-close"]);
    await run("p.csv", "slug,photo\nb,photo.png\n"); const [ml, csv] = scripts().filter((s) => s.includes("fill-apply"));
    expect([ml!.includes('"cutout":"background"'), csv!.includes('"cutout"')]).toEqual([true, false]);
  });

  it("reads CSV data", async () => {
    stub();
    const { template, out } = setup();
    const csv = write(work, "p.csv", 'slug,headline,price\nmar,"Spring, light",49\napr,April,59\n');
    const r = await runCommand(fill, [template, "--data", csv, "--key", "slug", "--out-dir", out]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("records[2]");
    expect(scripts().find((s) => s.includes("fill-apply"))).toContain("Spring, light");
  });

  it("records the manifest (madeBy.script === fill, args = the record) and run-log lines with cmd fill", async () => {
    stub();
    const { template, data, out } = setup();
    const r = await runCommand(fill, [template, "--data", data, "--key", "slug", "--out-dir", out, "--export", "PNG", "--limit", "1"]);
    expect(r.code).toBe(0);
    const m = readManifest(join(out, "mar.af"))!;
    expect(m.madeBy?.script).toBe("fill");
    expect(m.madeBy?.args).toEqual({ slug: "mar", headline: "Spring", price: "49" });
    expect(m.madeBy?.flags).toEqual(["--export PNG"]);
    expect(m.history.map((h) => h.kind)).toEqual(["fill", "save"]);
    expect(m.exports.map((e) => e.path)).toEqual([join(out, "mar.png")]);
    expect(m.af.sha256).not.toBe("");
    const runs = readRuns(work);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ cmd: "fill", script: template, outcome: "ok" });
    expect(runs[0]!.documents[0]!.path).toBe(join(out, "mar.af"));
  });
});
