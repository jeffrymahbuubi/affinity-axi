// Brand kits: schema errors, resolution order, injection, contrast, the brand
// command (init/list/show offline, check against the fake server), and the
// provenance chain run/batch -> run log -> manifest -> doc info.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BRAND_FLAG, contrastRatio, injectBrand, loadBrand, resolveBrandRef, validateKit } from "../src/affinity/brand.js";
import { recordSave } from "../src/affinity/manifest.js";
import { readRuns } from "../src/affinity/runlog.js";
import { make as makeBatch } from "../src/commands/batch.js";
import { make as makeBrand } from "../src/commands/brand.js";
import { make as makeDocOpen } from "../src/commands/doc-open.js";
import { make as makeRun } from "../src/commands/run.js";
import { ConnectError, type ConnectFn } from "../src/mcp/types.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_APP } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

let server: FakeServer;
let root: string;
let work: string;
let desktop: string;
const origCwd = process.cwd();
const origUrl = process.env["AFFINITY_MCP_URL"];
const origBrand = process.env["AFFINITY_AXI_BRAND"];

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  delete process.env["AFFINITY_AXI_BRAND"];
  root = realpathSync(mkdtempSync(join(tmpdir(), "axi-brand-")));
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

const KIT = {
  schema: "affinity-axi/brand/1",
  name: "Test Brand",
  colours: { ink: "#000000", mist: "#FFFFFF", sky: "#4C8DFF" },
  fonts: { headline: "Helvetica-Bold", body: "Helvetica" },
  type: { h1: { font: "headline", size: 64 } },
  space: [4, 8, 16],
  radius: { sm: 8 },
  pairs: [["ink", "mist"]],
};

const clone = (): Record<string, any> => JSON.parse(JSON.stringify(KIT));

function writeKit(rel: string, kit: unknown = KIT): string {
  const p = join(work, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(kit, null, 2));
  return p;
}

const offline: ConnectFn = () => {
  throw new ConnectError("offline command connected", "it must not");
};
const scripts = (): string[] => server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"]));
const uuidFor = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("validateKit", () => {
  const cases: Array<[string, (k: Record<string, any>) => void, RegExp]> = [
    ["a bad hex", (k) => (k.colours.ink = "black"), /colours\.ink must be #RRGGBB/],
    ["missing fonts.body", (k) => delete k.fonts.body, /fonts\.body is required/],
    ["missing fonts.headline", (k) => delete k.fonts.headline, /fonts\.headline is required/],
    ["a wrong schema", (k) => (k.schema = "x/1"), /schema must be "affinity-axi\/brand\/1"/],
    ["an empty name", (k) => (k.name = " "), /name must be a non-empty string/],
    ["non-ascending space", (k) => (k.space = [4, 16, 8]), /space\[2\] must be larger than the one before/],
    ["too short a space list", (k) => (k.space = [4]), /space must be an array of 2 to 16 numbers/],
    ["a pair with an unknown key", (k) => (k.pairs = [["ink", "nope"]]), /pairs\[0\] names an unknown colour key "nope"/],
    ["a type style with an unknown font role", (k) => (k.type.h1.font = "mono"), /type\.h1\.font must name a role in fonts/],
    ["a non-positive type size", (k) => (k.type.h1.size = 0), /type\.h1\.size must be a positive number/],
    ["a negative radius", (k) => (k.radius.sm = -1), /radius\.sm must be a number of px/],
    ["an svg logo", (k) => (k.logo = { primary: "logo.svg" }), /logo\.primary must be a PNG or JPEG file/],
    ["a colour key with a dot", (k) => (k.colours["a.b"] = "#111111"), /colours\.a\.b has a bad key/],
    ["no colours", (k) => (k.colours = {}), /colours must have 1 to 32 entries/],
  ];
  for (const [label, mutate, re] of cases) {
    it(`rejects ${label} naming the field`, () => {
      const k = clone();
      mutate(k);
      let err: any;
      try {
        validateKit(k, "kit.json");
      } catch (e) {
        err = e;
      }
      expect(err?.exitCode).toBe(2);
      expect(err.message).toMatch(/^brand kit kit\.json: /);
      expect(err.message).toMatch(re);
      expect(err.suggestion).toContain("brand init");
    });
  }

  it("accepts the kit and keeps unknown top-level keys", () => {
    const k = { ...clone(), note: "kept" };
    expect((validateKit(k, "kit.json") as any).note).toBe("kept");
  });

  it("the gallery kit validates and is the Lumen Studio brand", () => {
    const { kit } = loadBrand(join(origCwd, "examples/_brand/brand.json"));
    expect(kit.name).toBe("Lumen Studio");
    expect(kit.colours["ink"]).toBe("#1F2A44");
    expect(kit.space?.[4]).toBe(24);
  });
});

describe("resolveBrandRef", () => {
  it("flag beats env beats ./brand.json", () => {
    writeKit("brand.json");
    expect(resolveBrandRef("x.brand.json", { AFFINITY_AXI_BRAND: "e.brand.json" }, work)).toBe(join(work, "x.brand.json"));
    expect(resolveBrandRef(undefined, { AFFINITY_AXI_BRAND: "e.brand.json" }, work)).toBe(join(work, "e.brand.json"));
    expect(resolveBrandRef(undefined, {}, work)).toBe(join(work, "brand.json"));
  });
  it("is null without any kit, and a name maps under ./brands/", () => {
    expect(resolveBrandRef(undefined, {}, work)).toBeNull();
    expect(resolveBrandRef("acme", {}, work)).toBe(join(work, "brands", "acme.brand.json"));
    expect(resolveBrandRef("sub/acme.json", {}, work)).toBe(join(work, "sub", "acme.json"));
  });
  it("exports the shared flag spec", () => {
    expect(BRAND_FLAG).toMatchObject({ name: "brand", type: "string" });
  });
});

describe("loadBrand and injectBrand", () => {
  it("resolves logos against the kit folder, hashes the bytes and relativises the path", () => {
    const p = writeKit("brands/acme.brand.json", { ...clone(), logo: { primary: "art/logo.png" } });
    const { kit, ref } = loadBrand(p);
    expect(kit.logo?.["primary"]).toBe(join(work, "brands", "art", "logo.png"));
    expect(ref).toMatchObject({ name: "Test Brand", path: join("brands", "acme.brand.json") });
    expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(p, "utf8")).toContain("art/logo.png");
  });
  it("a missing file and bad JSON are usage errors", () => {
    expect(() => loadBrand(join(work, "none.json"))).toThrow(/cannot read brand kit/);
    writeFileSync(join(work, "bad.json"), "{nope");
    expect(() => loadBrand(join(work, "bad.json"))).toThrow(/not valid JSON/);
  });
  it("prepends one line and keeps the user's line count", () => {
    const kit = validateKit({ ...clone(), name: "A B" }, "k.json");
    const src = "line1\nline2\n";
    const out = injectBrand(src, kit);
    expect(out.startsWith("const AXI_BRAND = {")).toBe(true);
    expect(out.endsWith("; " + src)).toBe(true);
    expect(out.split("\n").length).toBe(src.split("\n").length);
    expect(out.split("\n")[0]).not.toMatch(new RegExp(String.fromCharCode(0x2028)));
    const json = /^const AXI_BRAND = (.*); line1$/.exec(out.split("\n")[0]!)![1]!;
    expect(JSON.parse(json).name).toBe("A B");
  });
});

describe("contrastRatio", () => {
  it("is 21 for black on white and 1 for equal colours, and symmetric", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#4C8DFF", "#4C8DFF")).toBeCloseTo(1, 5);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
  });
  it("the AA threshold flips at 4.5 in brand show", async () => {
    const k = clone();
    k.colours = { ink: "#000000", mist: "#FFFFFF", mid: "#767676", lite: "#999999" };
    k.pairs = [["ink", "mist"], ["mid", "mist"], ["lite", "mist"]];
    const p = writeKit("c.brand.json", k);
    const r = await runCommand(makeBrand(offline)["brand show"], [p]);
    expect(r.stdout).toMatch(/ink,mist,21.00,yes/);
    expect(r.stdout).toMatch(/mid,mist,4\.\d\d,yes/);
    expect(r.stdout).toMatch(/lite,mist,2\.\d\d,no/);
  });
});

describe("brand init, list and show (offline)", () => {
  const cmds = makeBrand(offline);

  it("init writes a valid starter once and refuses twice", async () => {
    const a = await runCommand(cmds["brand init"], ["Acme Co"]);
    expect(a.code).toBe(0);
    const file = join(work, "brands", "acme-co.brand.json");
    expect(existsSync(file)).toBe(true);
    expect(loadBrand(file).kit.name).toBe("Acme Co");
    expect(a.stdout).toContain("brand show acme-co");
    const b = await runCommand(cmds["brand init"], ["Acme Co"]);
    expect(b.code).toBe(1);
    expect(b.stdout).toContain("already exists; not overwriting");
  });

  it("init --from copies a kit under a new name and rebases logo paths", async () => {
    writeKit("brands/acme.brand.json", { ...clone(), logo: { primary: "logo.png" } });
    const r = await runCommand(cmds["brand init"], ["dark", "--from", "acme", "--dir", "other"]);
    expect(r.code).toBe(0);
    const copy = JSON.parse(readFileSync(join(work, "other", "dark.brand.json"), "utf8"));
    expect(copy.name).toBe("dark");
    expect(copy.logo.primary).toBe(join("..", "brands", "logo.png"));
    expect(loadBrand(join(work, "other", "dark.brand.json")).kit.logo?.["primary"]).toBe(join(work, "brands", "logo.png"));
  });

  it("list finds ./brands, ./brand.json and the env kit and marks the default", async () => {
    expect((await runCommand(cmds["brand list"], [])).stdout).toContain("brands: 0 found");
    writeKit("brands/a.brand.json");
    writeKit("brand.json", { ...clone(), name: "Local" });
    writeKit("env/e.brand.json", { ...clone(), name: "FromEnv" });
    const r1 = await runCommand(cmds["brand list"], []);
    expect(r1.stdout).toMatch(/brands\[2\]\{name,path,default,status\}:/);
    expect(r1.stdout).toMatch(/Local,brand\.json,default,ok/);
    process.env["AFFINITY_AXI_BRAND"] = join(work, "env", "e.brand.json");
    const r2 = await runCommand(cmds["brand list"], []);
    expect(r2.stdout).toMatch(/brands\[3\]/);
    expect(r2.stdout).toMatch(/FromEnv,.*e\.brand\.json,default,ok/);
  });

  it("list reports an invalid kit without failing", async () => {
    const k = clone();
    k.colours.ink = "red";
    writeKit("brands/bad.brand.json", k);
    const r = await runCommand(cmds["brand list"], []);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("invalid: colours.ink must be #RRGGBB");
  });

  it("show is offline, prints every table and reports extra keys", async () => {
    const p = writeKit("brand.json", { ...clone(), logo: { mark: "m.png" }, note: "x" });
    const r = await runCommand(cmds["brand show"], []);
    expect(r.code).toBe(0);
    for (const s of ["name: Test Brand", "colours[3]{key,hex}:", "fonts[2]{role,postscript}:", "type[1]{key,font,size,leading,spacing}:", "space: 4 8 16", "radius[1]{key,px}:", "logo[1]{key,path}:", "contrast[1]{fg,bg,ratio,aa}:", "extra: note"]) {
      expect(r.stdout).toContain(s);
    }
    expect(server.sessionsOpened()).toBe(0);
    expect((await runCommand(cmds["brand show"], [p])).code).toBe(0);
  });

  it("show with no kit is a usage error, and a bad kit names the field", async () => {
    const none = await runCommand(cmds["brand show"], []);
    expect(none.code).toBe(2);
    expect(none.stdout).toContain("no brand kit found");
    const k = clone();
    delete k.fonts.body;
    const bad = await runCommand(cmds["brand show"], [writeKit("b.brand.json", k)]);
    expect(bad.code).toBe(2);
    expect(bad.stdout).toContain("fonts.body is required");
  });
});

describe("brand check (fake server)", () => {
  const check = makeBrand(fakeConnect())["brand check"];
  const FONTS = [["Helvetica", "Helvetica", "Regular"], ["Helvetica", "Helvetica-Bold", "Bold"], ["Helvetica", "Helvetica-Oblique", ""]];

  function stub(rows: unknown[] = FONTS): void {
    server.onScript("affinity-axi:list-fonts", JSON.stringify(rows));
    server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
  }

  it("all good exits 0 and lists font and contrast checks", async () => {
    stub();
    const r = await runCommand(check, [writeKit("brand.json")]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("font headline,ok,Helvetica-Bold");
    expect(r.stdout).toContain("font body,ok,Helvetica");
    expect(r.stdout).toMatch(/contrast ink\/mist,ok,21\.00/);
    expect(r.stdout).toContain("summary: ok=3 warn=0 fail=0");
  });

  it("a missing font is a fail, with near matches, and exits 1", async () => {
    stub([["Helvetica", "Helvetica", ""]]);
    const r = await runCommand(check, [writeKit("brand.json")]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("font headline,fail,Helvetica-Bold is not installed; similar: Helvetica");
  });

  it("a low-contrast pair is a warn, not a fail", async () => {
    stub();
    const k = clone();
    k.colours.mid = "#999999";
    k.pairs = [["mid", "mist"]];
    const r = await runCommand(check, [writeKit("brand.json", k)]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/contrast mid\/mist,warn,2\.\d\d is below 4\.5/);
  });

  it("checks logos: ok under Desktop, fail when missing, not an image, or outside Desktop", async () => {
    stub();
    const png = Buffer.from("89504e470d0a1a0a00", "hex");
    writeFileSync(join(desktop, "good.png"), png);
    writeFileSync(join(desktop, "fake.png"), "text");
    writeFileSync(join(work, "outside.png"), png);
    const kit = { ...clone(), logo: { primary: join(desktop, "good.png"), mark: join(desktop, "fake.png"), gone: join(desktop, "gone.png"), far: join(work, "outside.png") } };
    const r = await runCommand(check, [writeKit("brand.json", kit)]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/logo primary,ok,/);
    expect(r.stdout).toMatch(/logo mark,fail,not a PNG or JPEG file/);
    expect(r.stdout).toMatch(/logo gone,fail,file not found/);
    expect(r.stdout).toMatch(/logo far,fail,outside the Desktop folder/);
  });

  it("a logo inside a hidden folder is a fail row and far still reads outside the Desktop", async () => {
    stub();
    const png = Buffer.from("89504e470d0a1a0a00", "hex");
    mkdirSync(join(desktop, ".logos"));
    writeFileSync(join(desktop, ".logos", "a.png"), png);
    writeFileSync(join(work, "outside.png"), png);
    const kit = { ...clone(), logo: { hid: join(desktop, ".logos", "a.png"), far: join(work, "outside.png") } };
    const r = await runCommand(check, [writeKit("brand.json", kit)]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("logo hid,fail,inside a hidden folder or file ('.logos'); Affinity cannot read it");
    expect(r.stdout).toMatch(/logo far,fail,outside the Desktop folder/);
  });

  it("a schema error is a usage error before any connection", async () => {
    stub();
    const k = clone();
    k.colours.ink = "x";
    const r = await runCommand(check, [writeKit("brand.json", k)]);
    expect(r.code).toBe(2);
    expect(server.sessionsOpened()).toBe(0);
  });
});

describe("run and batch --brand", () => {
  const run = makeRun(fakeConnect());
  const batch = makeBatch(fakeConnect());
  const logCwd = (): string => process.cwd();

  it("run injects AXI_BRAND on line 1, logs the BrandRef and keeps user lines", async () => {
    server.onScript("RUN_MARK", (s) => `ok ${uuidFor(1)} ${s.length}\n`);
    const kitPath = writeKit("brands/acme.brand.json");
    writeFileSync(join(work, "s.js"), "// RUN_MARK\nconsole.log('x');\n");
    const r = await runCommand(run, ["s.js", "--brand", "acme"]);
    expect(r.code).toBe(0);
    const sent = scripts().find((s) => s.includes("RUN_MARK"))!;
    expect(sent.split("\n")[0]).toMatch(/^const AXI_BRAND = \{.*"name":"Test Brand".*\}; \/\/ RUN_MARK$/);
    const rec = readRuns(logCwd())[0]!;
    expect(rec.brand).toMatchObject({ name: "Test Brand", path: join("brands", "acme.brand.json") });
    expect(rec.brand?.sha256).toBe(loadBrand(kitPath).ref.sha256);
    expect(rec.flags).toEqual([]);
  });

  it("run without any kit injects nothing and logs no brand", async () => {
    server.onScript("PLAIN", `ok ${uuidFor(2)}\n`);
    writeFileSync(join(work, "p.js"), "// PLAIN\n");
    await runCommand(run, ["p.js"]);
    expect(scripts().find((s) => s.includes("PLAIN"))).not.toContain("AXI_BRAND");
    expect(readRuns(logCwd())[0]!.brand).toBeUndefined();
  });

  it("run picks up ./brand.json by default and an invalid kit stops before connecting", async () => {
    server.onScript("DEFAULTKIT", `ok ${uuidFor(3)}\n`);
    writeFileSync(join(work, "d.js"), "// DEFAULTKIT\n");
    writeKit("brand.json");
    await runCommand(run, ["d.js"]);
    expect(scripts().find((s) => s.includes("DEFAULTKIT"))).toContain("const AXI_BRAND = ");
    const k = clone();
    k.fonts = { headline: "A" };
    writeKit("brand.json", k);
    const before = server.sessionsOpened();
    const r = await runCommand(run, ["d.js"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("fonts.body is required");
    expect(server.sessionsOpened()).toBe(before);
  });

  it("run puts the kit before ARGS and the helpers after the script", async () => {
    server.onScript("ORDER", `ok ${uuidFor(4)}\n`);
    writeKit("brand.json");
    writeFileSync(join(work, "o.js"), "// ORDER\n");
    await runCommand(run, ["o.js", "--args", '{"a":1}', "--with-helpers"]);
    const sent = scripts().find((s) => s.includes("ORDER"))!;
    const first = sent.split("\n")[0]!;
    expect(first.indexOf("const AXI_BRAND")).toBe(0);
    expect(first.indexOf("const ARGS")).toBeGreaterThan(first.indexOf("const AXI_BRAND"));
    expect(sent).toContain("function axiRect(");
  });

  it("batch logs the same BrandRef for each record and injects per record", async () => {
    server.onScript("BATCH_MARK", (s) => JSON.stringify({ uuid: uuidFor(/"key":"(\w+)"/.exec(s)![1] === "a" ? 11 : 12) }));
    writeKit("brands/acme.brand.json");
    writeFileSync(join(work, "t.js"), "/* BATCH_MARK */\n");
    writeFileSync(join(work, "d.json"), JSON.stringify([{ slug: "a" }, { slug: "b" }]));
    const r = await runCommand(batch, ["t.js", "--data", "d.json", "--key", "slug", "--brand", "acme"]);
    expect(r.code).toBe(0);
    const sent = scripts().filter((s) => s.includes("BATCH_MARK"));
    expect(sent).toHaveLength(2);
    for (const s of sent) expect(s.split("\n")[0]).toContain("const AXI_BRAND = ");
    const recs = readRuns(logCwd());
    expect(recs.map((x) => x.cmd)).toEqual(["batch", "batch"]);
    for (const rec of recs) expect(rec.brand?.name).toBe("Test Brand");
  });

  it("batch rejects a bad kit before connecting", async () => {
    const k = clone();
    k.colours.ink = "x";
    writeKit("brand.json", k);
    writeFileSync(join(work, "t.js"), "/* BATCH_MARK */\n");
    writeFileSync(join(work, "d.json"), JSON.stringify([{ slug: "a" }]));
    const r = await runCommand(batch, ["t.js", "--data", "d.json"]);
    expect(r.code).toBe(2);
    expect(server.sessionsOpened()).toBe(0);
  });
});

describe("provenance: manifest and doc info", () => {
  const run = makeRun(fakeConnect());
  const info = makeDocOpen(fakeConnect())["doc info"];

  async function madeWithKit(): Promise<string> {
    server.onScript("PROV", `ok ${uuidFor(7)}\n`);
    writeKit("brands/acme.brand.json");
    writeFileSync(join(work, "p.js"), "// PROV\n");
    await runCommand(run, ["p.js", "--brand", "acme"]);
    const af = join(work, "made.af");
    writeFileSync(af, "af bytes");
    return af;
  }

  it("recordSave copies the kit into history and madeBy", async () => {
    const af = await madeWithKit();
    const m = recordSave(af, uuidFor(7), null, process.cwd());
    expect(m.madeBy?.brand?.name).toBe("Test Brand");
    expect(m.history.find((h) => h.kind === "run")?.brand?.name).toBe("Test Brand");
    expect(m.history.find((h) => h.kind === "save")?.brand).toBeUndefined();
  });

  it("madeBy.brand is the first kit a folded run used, even when the first run had none", async () => {
    server.onScript("SETUP", `ok ${uuidFor(9)}\n`);
    server.onScript("STYLED", `ok ${uuidFor(9)}\n`);
    writeKit("brands/acme.brand.json");
    writeFileSync(join(work, "setup.js"), "// SETUP\n");
    writeFileSync(join(work, "styled.js"), "// STYLED\n");
    await runCommand(run, ["setup.js"]);
    await runCommand(run, ["styled.js", "--brand", "acme"]);
    const af = join(work, "two.af");
    writeFileSync(af, "af bytes");
    const m = recordSave(af, uuidFor(9), null, process.cwd());
    expect(m.madeBy?.script).toBe("setup.js");
    expect(m.madeBy?.brand?.name).toBe("Test Brand");
    expect(m.history.filter((h) => h.kind === "run").map((h) => h.brand?.name)).toEqual([undefined, "Test Brand"]);
  });

  it("a run without a kit leaves madeBy.brand unset", async () => {
    server.onScript("NOKIT", `ok ${uuidFor(8)}\n`);
    writeFileSync(join(work, "n.js"), "// NOKIT\n");
    await runCommand(run, ["n.js"]);
    const af = join(work, "n.af");
    writeFileSync(af, "af bytes");
    const m = recordSave(af, uuidFor(8), null, process.cwd());
    expect(m.madeBy).not.toBeNull();
    expect(m.madeBy?.brand).toBeUndefined();
  });

  it("doc info prints the brand line and flags a changed kit", async () => {
    const af = await madeWithKit();
    recordSave(af, uuidFor(7), null, process.cwd());
    const a = await runCommand(info, [af]);
    expect(a.stdout).toContain(`brand: Test Brand (${join("brands", "acme.brand.json")})`);
    expect(a.stdout).not.toContain("(changed)");
    const kit = clone();
    kit.colours.sky = "#000001";
    writeKit("brands/acme.brand.json", kit);
    const b = await runCommand(info, [af]);
    expect(b.stdout).toContain("acme.brand.json) (changed)");
    rmSync(join(work, "brands"), { recursive: true });
    const c = await runCommand(info, [af]);
    expect(c.code).toBe(0);
    expect(c.stdout).toContain("brand: Test Brand");
    expect(c.stdout).not.toContain("(changed)");
  });
});
