// The template pack: static source hygiene (no colour or font literal, no close,
// guards), a script harness with stubbed helpers (slots, kit tokens, safe zones,
// kit and argument errors), the `templates` commands against the fake MCP server
// (script order, manifest, dirty save, usage errors with no connection).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findPlatform, platformHelperSource } from "../src/affinity/platforms.js";
import { scanForAi, scanForBlocking } from "../src/affinity/guard.js";
import { BRAND_SOURCE } from "../src/affinity/helpers-brand.js";
import { readManifest } from "../src/affinity/manifest.js";
import { make } from "../src/commands/templates.js";
import { TEMPLATES, templateByName, type Template } from "../src/templates/index.js";
import { ConnectError } from "../src/mcp/types.js";
import { parseToon } from "../src/output/toon.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_APP } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

const BRAND_FILE = fileURLToPath(new URL("../examples/_brand/brand.json", import.meta.url));
const KIT = JSON.parse(readFileSync(BRAND_FILE, "utf8")) as Record<string, any>;
const KIT_VALUES = new Set([...Object.values(KIT["colours"] as Record<string, string>), ...Object.values(KIT["fonts"] as Record<string, string>)]);
const SLOT_NAMES = ["headline", "sub", "photo", "cta", "url", "footnote"];

describe("the template table", () => {
  it("has the five templates with unique, folder-safe names", () => {
    expect(TEMPLATES.map((t) => t.name)).toEqual(["ig-post", "ig-story", "carousel-cover", "og-card", "price-post"]);
    for (const t of TEMPLATES) expect(t.name).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(new Set(TEMPLATES.map((t) => t.name)).size).toBe(TEMPLATES.length);
    expect(templateByName("og-card")?.w).toBe(1200);
    expect(templateByName("nope")).toBeUndefined();
  });

  it("takes every size from the platform table", () => {
    for (const t of TEMPLATES) {
      const p = findPlatform(t.platform!);
      expect(p, t.name).toBeDefined();
      expect([t.w, t.h], t.name).toEqual([p!.w, p!.h]);
    }
  });

  it("gives every template headline, sub and cta; photo only on the photo templates", () => {
    for (const t of TEMPLATES) for (const k of ["headline", "sub", "cta"]) expect(t.slots, t.name).toContain(k);
    expect(TEMPLATES.filter((t) => t.slots.includes("photo")).map((t) => t.name)).toEqual(["ig-post", "ig-story", "carousel-cover"]);
    expect(templateByName("og-card")!.slots).toContain("url");
    expect(templateByName("price-post")!.slots).toContain("footnote");
  });
});

describe("template sources (static)", () => {
  for (const t of TEMPLATES) {
    describe(t.name, () => {
      it("passes the guards, never closes, and is String.raw safe", () => {
        expect(scanForAi(t.source)).toEqual([]);
        expect(scanForBlocking(t.source)).toEqual([]);
        expect(t.source).not.toMatch(/close\s*\(|closeAsync|dialog\.js|generat/i);
        expect(t.source).not.toContain("`");
        expect(t.source).not.toContain("${");
      });

      it("holds no colour literal and no font literal", () => {
        expect(t.source).not.toMatch(/#[0-9a-fA-F]{3,6}/);
        expect(t.source).not.toMatch(/font\s*:\s*['"]/);
        expect(t.source).not.toMatch(/Helvetica|Fraunces|Arial|Inter\b/);
      });

      it("starts with its marker and names each declared slot", () => {
        expect(t.source.startsWith(`/* affinity-axi:template ${t.name} */\n`)).toBe(true);
        for (const s of t.slots) expect(t.source).toContain(`'slot:${s}'`);
        for (const other of SLOT_NAMES.filter((s) => !t.slots.includes(s) && s !== "photo")) expect(t.source).not.toContain(`'slot:${other}'`);
      });
    });
  }
});

// ---- harness: the script with stubbed helpers ----

type Call = [string, ...any[]];

const STUBS = `
var calls = [];
var names = [];
function axiDoc(w, h) { calls.push(['doc', w, h]); return { sessionUuid: 'DOC-1' }; }
function axiArtboard(doc, o) { calls.push(['artboard', o]); }
function axiOn(doc, n) { calls.push(['on', n]); }
function axiRect(doc, o) { calls.push(['rect', o]); if (o.name) { names.push(o.name); } return {}; }
function axiText(doc, o) { calls.push(['text', o]); if (o.name) { names.push(o.name); } return {}; }
function axiTable(doc, o) { calls.push(['table', o]); if (o.name) { names.push(o.name); } return {}; }
function axiImage(doc, o) { calls.push(['image', o]); names.push(o.name + '-frame'); names.push(o.name); return {}; }
function axiRename(doc, ref, name) { calls.push(['rename', ref, name]); names = names.map(function (n) { return n === ref ? name : n; }); }
function axiNames(doc) { return names.map(function (n) { return { name: n }; }); }
`;

interface Ran {
  logs: string[];
  calls: Call[];
  reply: { uuid: string | null; slots?: string[]; error?: string };
}

function run(t: Template, o: { kit?: unknown; args?: unknown; hooks?: string } = {}): Ran {
  const body = `${STUBS}\n${o.hooks ?? ""}\n${BRAND_SOURCE}\n${platformHelperSource()}\n${t.source}\nreturn calls;`;
  const logs: string[] = [];
  const calls = new Function("require", "console", "ARGS", "AXI_BRAND", body)(
    () => {
      throw new Error("SDK not available in tests");
    },
    { log: (s: string) => logs.push(s) },
    o.args,
    o.kit ?? KIT,
  ) as Call[];
  return { logs, calls, reply: logs.length > 0 ? JSON.parse(logs[logs.length - 1]!) : (undefined as never) };
}

const kitWithout = (path: string[]): unknown => {
  const k = JSON.parse(JSON.stringify(KIT));
  let cur = k;
  for (const p of path.slice(0, -1)) cur = cur[p];
  delete cur[path[path.length - 1]!];
  return k;
};

const boxes = (calls: Call[]): Array<{ x: number; y: number; w: number; h: number }> => calls.filter((c) => c[0] === "rect" || c[0] === "table").map((c) => c[1]);

describe("template scripts (stubbed helpers, demo kit)", () => {
  for (const t of TEMPLATES) {
    describe(t.name, () => {
      it("creates one artboard of the right size and prints one JSON line with exactly the declared slots", () => {
        const r = run(t);
        expect(r.logs).toHaveLength(1);
        expect(r.reply.uuid).toBe("DOC-1");
        expect([...r.reply.slots!].sort()).toEqual([...t.slots].sort());
        expect(r.calls.filter((c) => c[0] === "doc")).toEqual([["doc", t.w, t.h]]);
        const ab = r.calls.filter((c) => c[0] === "artboard");
        expect(ab).toHaveLength(1);
        expect(ab[0]![1]).toMatchObject({ name: t.name, x: 0, y: 0, w: t.w, h: t.h });
        expect(r.calls.filter((c) => c[0] === "on")).toEqual([["on", t.name]]);
      });

      it("takes every colour and font from the kit", () => {
        const r = run(t);
        const used: string[] = [];
        for (const c of r.calls) {
          const o = c[1];
          if (c[0] === "artboard" && o.fill) used.push(o.fill);
          if (c[0] === "rect" && o.fill) used.push(o.fill);
          if (c[0] === "text") used.push(o.colour, o.font);
          if (c[0] === "table") used.push(o.colour, o.font, o.header.colour, o.header.font);
        }
        expect(used.length).toBeGreaterThan(8);
        for (const u of used) expect(KIT_VALUES.has(u), String(u)).toBe(true);
      });

      it("keeps every shape and baseline inside the canvas", () => {
        const r = run(t);
        for (const b of boxes(r.calls)) expect([b.x, b.y, b.x + b.w, b.y + b.h].every((v, i) => v >= 0 && v <= (i % 2 === 0 ? t.w : t.h))).toBe(true);
        for (const c of r.calls.filter((x) => x[0] === "text")) expect(c[1].y > 0 && c[1].y <= t.h).toBe(true);
      });

      for (const key of ["display", "h1", "body"]) {
        it(`refuses a kit without type.${key} before creating a document`, () => {
          expect(() => run(t, { kit: kitWithout(["type", key]) })).toThrow(`template ${t.name}: the kit needs type.${key}`);
        });
      }

      it("refuses a kit whose colours cannot carry text", () => {
        const flat = JSON.parse(JSON.stringify(KIT));
        flat.colours = { a: "#808080", b: "#858585", c: "#7B7B7B" };
        expect(() => run(t, { kit: flat })).toThrow(/no kit colour reads on/);
      });

      it("reports a drawing failure with the document uuid and closes nothing", () => {
        const r = run(t, { hooks: "function axiRect() { throw new Error('boom'); }\nfunction axiImage() { throw new Error('boom'); }" });
        expect(r.reply).toEqual({ uuid: "DOC-1", error: "boom" });
      });
    });
  }

  it("ig-story keeps content between the story safe insets; carousel-cover inside the grid-crop insets", () => {
    const safe = findPlatform("story")!.safe!;
    const story = run(templateByName("ig-story")!);
    for (const b of boxes(story.calls)) expect(b.y >= safe.top! && b.y + b.h <= 1920 - safe.bottom!).toBe(true);
    for (const c of story.calls.filter((x) => x[0] === "text")) expect(c[1].y >= safe.top! && c[1].y <= 1920 - safe.bottom!).toBe(true);
    for (const b of boxes(run(templateByName("carousel-cover")!).calls)) expect(b.x >= 34 && b.x + b.w <= 1080 - 34).toBe(true);
  });

  it("uses a rounded picture frame for the photo placeholder, and a renamed frame for a real photo", () => {
    const t = templateByName("ig-post")!;
    const flat = run(t);
    const ph = flat.calls.find((c) => c[0] === "rect" && c[1].name === "slot:photo")!;
    expect(ph[1]).toMatchObject({ frame: true, radius: 16, fill: KIT["colours"]["sky"] });
    expect(flat.calls.some((c) => c[0] === "image")).toBe(false);

    const withPhoto = run(t, { args: { photo: "/Desktop/p.png" } });
    expect(withPhoto.calls.find((c) => c[0] === "image")![1]).toMatchObject({ path: "/Desktop/p.png", fit: "cover", name: "slot:photo", radius: 16 });
    expect(withPhoto.calls.find((c) => c[0] === "rename")).toEqual(["rename", "slot:photo-frame", "photo-frame"]);
    expect(withPhoto.reply.slots).toContain("photo");
    expect(withPhoto.reply.slots).not.toContain("photo-frame");
  });

  it("price-post draws a price-table from ARGS.rows or three default rows", () => {
    const t = templateByName("price-post")!;
    const def = run(t).calls.find((c) => c[0] === "table")![1];
    expect(def.name).toBe("price-table");
    expect(def.rows).toHaveLength(4);
    expect(def.rows[0]).toHaveLength(3);
    const custom = run(t, { args: { rows: [["Item", "Price"], ["Cut", 30]] } }).calls.find((c) => c[0] === "table")![1];
    expect(custom.rows).toEqual([["Item", "Price"], ["Cut", 30]]);
    expect(custom.h).toBe(200);
  });

  it("price-post validates rows before creating a document", () => {
    const t = templateByName("price-post")!;
    const bad: Array<[string, unknown, RegExp]> = [
      ["not an array", "x", /1 to 5 rows/],
      ["empty", [], /1 to 5 rows/],
      ["six rows", Array.from({ length: 6 }, () => ["a"]), /1 to 5 rows/],
      ["five columns", [["a", "b", "c", "d", "e"]], /1 to 4 cells/],
      ["ragged", [["a", "b"], ["c"]], /row 1 needs 2 cells/],
      ["bad cell", [["a"], [{}]], /not text or a number/],
    ];
    for (const [label, rows, re] of bad) expect(() => run(t, { args: { rows } }), label).toThrow(re);
  });
});

// ---- the commands against the fake server ----

let server: FakeServer;
let root: string;
let work: string;
let desktop: string;
const origCwd = process.cwd();
const origUrl = process.env["AFFINITY_MCP_URL"];
const origBrand = process.env["AFFINITY_AXI_BRAND"];
const UUID = "00000000-0000-4000-8000-0000000000a1";

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  delete process.env["AFFINITY_AXI_BRAND"];
  root = mkdtempSync(join(tmpdir(), "axi-tpl-"));
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
  if (origBrand === undefined) delete process.env["AFFINITY_AXI_BRAND"];
  else process.env["AFFINITY_AXI_BRAND"] = origBrand;
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

const cmds = (): ReturnType<typeof make> => make(fakeConnect());
const scripts = (): string[] => server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"]));
const markers = (): string[] => scripts().map((s) => /affinity-axi:([a-z-]+(?: [a-z0-9-]+)?)/.exec(s)?.[1] ?? "?");
const quoted = (script: string, name: string): string => JSON.parse(new RegExp(`const ${name} = (".*");`).exec(script)![1]!) as string;

function stub(o: { reply?: string; dirtyAfterSave?: boolean; closeStatus?: string } = {}): { seenPhoto: () => string | undefined } {
  let photo: string | undefined;
  server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
  server.onScript("affinity-axi:template ", (script) => {
    const args = JSON.parse(/const ARGS = (\{.*?\}); /.exec(script)![1]!) as { photo?: string };
    photo = args.photo;
    if (photo && photo.includes("placeholder")) expect([...readFileSync(photo).subarray(1, 4)].map((b) => String.fromCharCode(b)).join("")).toBe("PNG");
    return o.reply ?? JSON.stringify({ uuid: UUID, slots: ["photo", "headline", "sub", "cta"] });
  });
  server.onScript("affinity-axi:doc-save", (script) => {
    const path = quoted(script, "outPath");
    writeFileSync(path, `af:${path}`);
    return JSON.stringify({ status: "saved", uuid: UUID, path, dirty: o.dirtyAfterSave === true });
  });
  server.onScript("affinity-axi:doc-close", JSON.stringify({ status: o.closeStatus ?? "closed", uuid: UUID }));
  return { seenPhoto: () => photo };
}

const newArgs = (name: string, extra: string[] = []): string[] => [name, "--out", join(desktop, "x.af"), "--brand", BRAND_FILE, ...extra];

describe("templates list", () => {
  it("lists the five templates offline", async () => {
    const mod = make(() => {
      throw new ConnectError("must not connect", "none");
    })["templates list"];
    const r = await runCommand(mod, []);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("templates[5]{name,size,platform,slots}:");
    expect(r.stdout).toContain("  ig-post,1080x1080,ig-square,headline sub photo cta\n");
    expect(r.stdout).toContain("  og-card,1200x630,og,headline sub cta url\n");
    expect(parseToon(r.stdout).ok).toBe(true);
    expect(server.sessionsOpened()).toBe(0);
  });
});

describe("templates new", () => {
  it("builds, saves, records and closes in that order, with the kit in the script", async () => {
    const s = stub();
    const r = await runCommand(cmds()["templates new"], newArgs("ig-post"));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("template: ig-post");
    expect(r.stdout).toContain(`doc: ${UUID.toUpperCase()}`);
    expect(r.stdout).toContain(`saved: ${join(desktop, "x.af")}`);
    expect(r.stdout).toContain("slots[4]: headline, sub, photo, cta");
    expect(r.stdout).toContain("affinity-axi fill");
    expect(parseToon(r.stdout).ok).toBe(true);

    expect(markers()).toEqual(["app-info", "template ig-post", "doc-save", "doc-close"]);
    const build = scripts()[1]!;
    expect(build.startsWith("const AXI_BRAND = ")).toBe(true);
    expect(build).toContain("Lumen Studio");
    expect(build).toContain("/* affinity-axi:template ig-post */");
    expect(build).toContain("function axiRect(");
    // the placeholder photo existed while the script ran and is gone afterwards
    expect(s.seenPhoto()).toMatch(/axi-photo-placeholder-\d+\.png$/);
    expect(existsSync(s.seenPhoto()!)).toBe(false);

    const out = join(desktop, "x.af");
    const m = readManifest(out)!;
    expect(m.madeBy?.script).toBe("templates/ig-post");
    expect(m.madeBy?.brand?.name).toBe("Lumen Studio");
    expect(resolve(dirname(out), m.madeBy!.brand!.path)).toBe(BRAND_FILE);
    expect(m.history.map((h) => h.kind)).toEqual(["templates", "save"]);
    expect(m.history[0]!.script).toBe("templates/ig-post");
    expect(m.history[0]!.brand?.name).toBe("Lumen Studio");
  });

  it("passes a real photo through and leaves it alone", async () => {
    const photo = join(desktop, "p.png");
    writeFileSync(photo, "png");
    stub();
    const r = await runCommand(cmds()["templates new"], newArgs("ig-story", ["--args", JSON.stringify({ photo })]));
    expect(r.code).toBe(0);
    expect(scripts()[1]).toContain(`"photo":${JSON.stringify(photo)}`);
    expect(existsSync(photo)).toBe(true);
    expect(markers()[1]).toBe("template ig-story");
  });

  it("sends rows to price-post and no photo placeholder", async () => {
    const s = stub({ reply: JSON.stringify({ uuid: UUID, slots: ["headline", "sub", "footnote", "cta"] }) });
    const r = await runCommand(cmds()["templates new"], newArgs("price-post", ["--args", '{"rows":[["a","b"],["c","d"]]}']));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("slots[4]: headline, sub, footnote, cta");
    expect(scripts()[1]).toContain('"rows":[["a","b"],["c","d"]]');
    expect(s.seenPhoto()).toBeUndefined();
  });

  it("leaves a dirty document open and exits 1", async () => {
    stub({ dirtyAfterSave: true });
    const r = await runCommand(cmds()["templates new"], newArgs("ig-post"));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(UUID.toUpperCase());
    expect(r.stdout).toContain("left open");
    expect(markers()).not.toContain("doc-close");
  });

  it("exits 1 and closes nothing when the document will not close", async () => {
    stub({ closeStatus: "dirty" });
    const r = await runCommand(cmds()["templates new"], newArgs("ig-post"));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("do not close it blindly");
  });

  it("reports a drawing failure with the unsaved document and does not save", async () => {
    stub({ reply: JSON.stringify({ uuid: UUID, error: "boom" }) });
    const r = await runCommand(cmds()["templates new"], newArgs("ig-post"));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("boom");
    expect(r.stdout).toContain("unsaved and left open");
    expect(markers()).toEqual(["app-info", "template ig-post"]);
  });

  it("reports a kit error from the script as an error with nothing created", async () => {
    stub({ reply: "Error: template ig-post: the kit needs type.h1\n    at main:3:1" });
    const r = await runCommand(cmds()["templates new"], newArgs("ig-post"));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("the kit needs type.h1");
    expect(markers()).toEqual(["app-info", "template ig-post"]);
  });

  it("never overwrites a file changed outside affinity-axi", async () => {
    stub();
    expect((await runCommand(cmds()["templates new"], newArgs("ig-post"))).code).toBe(0);
    const out = join(desktop, "x.af");
    writeFileSync(out, "hand edited");
    const before = server.sessionsOpened();
    const r = await runCommand(cmds()["templates new"], newArgs("ig-post"));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("changed outside affinity-axi");
    expect(server.sessionsOpened()).toBe(before);
    expect(readFileSync(out, "utf8")).toBe("hand edited");
  });

  it("refuses an existing .af that affinity-axi never saved, before any connection", async () => {
    stub();
    const out = join(desktop, "x.af");
    writeFileSync(out, "hand made");
    const r = await runCommand(cmds()["templates new"], newArgs("ig-post"));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("x.af exists and was not saved by affinity-axi (no manifest); refusing to overwrite");
    expect(r.stdout).toContain("templates new ig-post --out");
    expect(r.stdout).toContain("--force");
    expect(server.sessionsOpened()).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("hand made");
  });

  it("--force replaces an unmanaged .af and the save entry is forced", async () => {
    stub();
    const out = join(desktop, "x.af");
    writeFileSync(out, "hand made");
    const r = await runCommand(cmds()["templates new"], newArgs("ig-post", ["--force"]));
    expect(r.code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(`af:${out}`);
    expect(readManifest(out)!.history.at(-1)).toMatchObject({ kind: "save", forced: true });
  });

  it("--force also replaces a hand-edited .af; regenerating a fresh one needs no flag", async () => {
    stub();
    const out = join(desktop, "x.af");
    expect((await runCommand(cmds()["templates new"], newArgs("ig-post"))).code).toBe(0);
    expect((await runCommand(cmds()["templates new"], newArgs("ig-post"))).code).toBe(0);
    expect(readManifest(out)!.history.at(-1)).not.toHaveProperty("forced");
    writeFileSync(out, "hand edited");
    expect((await runCommand(cmds()["templates new"], newArgs("ig-post", ["--force"]))).code).toBe(0);
    expect(readManifest(out)!.history.at(-1)).toMatchObject({ kind: "save", forced: true });
  });

  it("refuses a --out outside the Desktop folder after connecting, before building", async () => {
    stub();
    const r = await runCommand(cmds()["templates new"], ["ig-post", "--out", join(root, "elsewhere", "x.af"), "--brand", BRAND_FILE]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("outside the Desktop folder");
    expect(markers()).toEqual(["app-info"]);
  });

  it("refuses a hidden --out or a hidden photo offline, before any connection", async () => {
    const a = await runCommand(cmds()["templates new"], ["ig-post", "--out", join(desktop, ".designs", "p.af"), "--brand", BRAND_FILE]);
    expect(a.code).toBe(2);
    expect(a.stdout).toContain("--out is inside a hidden folder or file ('.designs')");
    mkdirSync(join(desktop, ".pics"));
    const photo = join(desktop, ".pics", "a.png");
    writeFileSync(photo, "png");
    const b = await runCommand(cmds()["templates new"], newArgs("ig-post", ["--args", JSON.stringify({ photo })]));
    expect(b.code).toBe(2);
    expect(b.stdout).toContain("photo is inside a hidden folder or file ('.pics')");
    expect(server.sessionsOpened()).toBe(0);
  });

  describe("usage errors never connect", () => {
    const cases: Array<[string, string[], RegExp]> = [
      ["unknown template", ["nope", "--out", "x.af", "--brand", BRAND_FILE], /unknown template 'nope'/],
      ["no --out", ["ig-post", "--brand", BRAND_FILE], /--out is required/],
      ["--out without .af", ["ig-post", "--out", "x.png", "--brand", BRAND_FILE], /must end in \.af/],
      ["bad --args", ["ig-post", "--out", "x.af", "--brand", BRAND_FILE, "--args", "{"], /not valid JSON/],
      ["photo on a template without a photo", ["og-card", "--out", "x.af", "--brand", BRAND_FILE, "--args", '{"photo":"p.png"}'], /no photo slot/],
      ["bad --timeout", ["ig-post", "--out", "x.af", "--brand", BRAND_FILE, "--timeout", "0"], /invalid --timeout/],
      ["--timeout in exponent form", ["ig-post", "--out", "x.af", "--brand", BRAND_FILE, "--timeout", "1e3"], /invalid --timeout/],
      ["fractional --timeout", ["ig-post", "--out", "x.af", "--brand", BRAND_FILE, "--timeout", "1.5"], /invalid --timeout/],
    ];
    for (const [label, argv, re] of cases) {
      it(label, async () => {
        const r = await runCommand(cmds()["templates new"], argv);
        expect(r.code).toBe(2);
        expect(r.stdout).toMatch(re);
        expect(server.sessionsOpened()).toBe(0);
      });
    }

    it("no brand kit anywhere", async () => {
      const r = await runCommand(cmds()["templates new"], ["ig-post", "--out", "x.af"]);
      expect(r.code).toBe(2);
      expect(r.stdout).toContain("templates need a brand kit");
      expect(server.sessionsOpened()).toBe(0);
    });

    it("a kit without type.h1", async () => {
      const kit = join(work, "thin.brand.json");
      writeFileSync(kit, JSON.stringify(kitWithout(["type", "h1"])));
      const r = await runCommand(cmds()["templates new"], ["ig-post", "--out", "x.af", "--brand", kit]);
      expect(r.code).toBe(2);
      expect(r.stdout).toContain("template ig-post: the kit needs type.h1");
      expect(server.sessionsOpened()).toBe(0);
    });

    it("the ./brand.json in the working folder is used when --brand is absent", async () => {
      writeFileSync(join(work, "brand.json"), JSON.stringify(KIT));
      stub();
      const r = await runCommand(cmds()["templates new"], ["og-card", "--out", join(desktop, "y.af")]);
      expect(r.code).toBe(0);
      expect(scripts()[1]).toContain("const AXI_BRAND = ");
    });
  });
});
