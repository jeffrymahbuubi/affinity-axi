// doc open / doc info / doc note, in-process against the fake MCP server.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DOC_OPEN, make } from "../src/commands/doc-open.js";
import type { Inventory, Manifest } from "../src/affinity/manifest-types.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_APP, FIXTURE_UUID_2 } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

let server: FakeServer;
let root: string;
let desktop: string;
const origUrl = process.env["AFFINITY_MCP_URL"];

const cmds = make(fakeConnect());
const scripts = () => server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"]));
const marked = (m: string) => scripts().filter((s) => s.startsWith(`/* affinity-axi:${m} */`));

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  root = mkdtempSync(join(tmpdir(), "axi-open-"));
  desktop = join(root, "Desktop");
  mkdirSync(desktop);
  server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
});

afterEach(async () => {
  if (origUrl === undefined) delete process.env["AFFINITY_MCP_URL"];
  else process.env["AFFINITY_MCP_URL"] = origUrl;
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

const SAVED_AT = "2026-10-24T13:02:11.000Z";

function inventory(names: string[]): Inventory {
  return {
    at: SAVED_AT,
    doc: { uuid: FIXTURE_UUID_2, title: "promo.af", path: "", units: "Pixel", width: 800, height: 600, dpi: 72 },
    artboards: [],
    nodes: names.map((name, i) => ({ path: `0/${i}`, type: "Rectangle", name, box: [0, 0, 10, 10], visible: true })),
    counts: { nodes: names.length, named: names.filter(Boolean).length, text: 0, images: 0 },
  };
}

/** Writes an .af plus a hand-made manifest; `tamper` changes the .af afterwards so the hash no longer matches. */
function seed(name: string, opts: { tamper?: boolean; madeBy?: boolean; names?: string[]; extra?: Record<string, unknown> } = {}): string {
  const af = join(desktop, name);
  writeFileSync(af, "AFFINITY-BYTES");
  const m: Manifest & Record<string, unknown> = {
    schema: "affinity-axi/manifest/1",
    file: name,
    af: { sha256: createHash("sha256").update("AFFINITY-BYTES").digest("hex"), bytes: 14, savedAt: SAVED_AT, tool: "affinity-axi 0.1.0" },
    madeBy: opts.madeBy ? { script: "scripts/promo.js", scriptSha256: "abc", args: { headline: "Hi" }, flags: ["--with-helpers"] } : null,
    history: [{ time: SAVED_AT, kind: "save" }],
    exports: [],
    ai: { generated: false, records: 0 },
    inventory: inventory(opts.names ?? ["bg", "headline"]),
    notes: [],
    ...(opts.extra ?? {}),
  };
  writeFileSync(af + ".axi.json", JSON.stringify(m, null, 2) + "\n");
  if (opts.tamper) writeFileSync(af, "HAND-EDITED");
  return af;
}

function stubOpen(status: "opened" | "already-open" | "error" = "opened", names = ["bg", "headline"]): void {
  server.onScript("affinity-axi:doc-open", JSON.stringify(status === "error" ? { status, message: "cannot read file" } : { status, uuid: FIXTURE_UUID_2, title: "promo.af", dirty: false }));
  server.onScript("getSpreadVisibleBox", JSON.stringify(inventory(names)));
}

const manifestOf = (af: string) => JSON.parse(readFileSync(af + ".axi.json", "utf8")) as Manifest & Record<string, unknown>;

describe("doc-open (module)", () => {
  it("exports the three commands", () => {
    expect(Object.keys(cmds).sort()).toEqual(["doc info", "doc note", "doc open"]);
    for (const [k, c] of Object.entries(cmds)) expect(c.spec.name).toBe(k);
  });

  it("DOC_OPEN looks for an open document before loading and never closes", () => {
    const s = DOC_OPEN("/x/a.af");
    expect(s.startsWith("/* affinity-axi:doc-open */")).toBe(true);
    expect(s.indexOf("Document.all.find")).toBeGreaterThan(-1);
    expect(s.indexOf("Document.all.find")).toBeLessThan(s.indexOf("Document.load"));
    expect(s).toContain("if (!doc)");
    expect(s).not.toContain("close(");
  });
});

describe("doc open", () => {
  it("opens a fresh asset: status, manifest fresh, madeBy, named list and help", async () => {
    const af = seed("promo.af", { madeBy: true });
    stubOpen();
    const r = await runCommand(cmds["doc open"], [af]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`doc: ${FIXTURE_UUID_2}`);
    expect(r.stdout).toContain("status: opened");
    expect(r.stdout).toContain("manifest: fresh");
    expect(r.stdout).toContain(`madeBy: scripts/promo.js --args '{"headline":"Hi"}' --with-helpers`);
    expect(r.stdout).toContain("named[2]: bg, headline");
    expect(r.stdout).toMatch(/help\[3\]:/);
    expect(r.stdout).toContain("inspect 01E35352 --named");
    expect(r.stdout).toContain("doc save 01E35352 ");
    expect(marked("doc-open")).toHaveLength(1);
  });

  it("reports an already-open document and a refreshed inventory", async () => {
    const af = seed("promo.af");
    stubOpen("already-open", ["bg", "headline", "cta"]);
    const r = await runCommand(cmds["doc open"], [af]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("status: already-open");
    expect(r.stdout).toContain("named[3]: bg, headline, cta");
    expect(manifestOf(af).inventory!.counts.named).toBe(3);
  });

  it("says stale with the last save time when the file changed outside the tool", async () => {
    const af = seed("promo.af", { tamper: true });
    stubOpen();
    const r = await runCommand(cmds["doc open"], [af]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`manifest: stale (changed outside affinity-axi after ${SAVED_AT})`);
  });

  it("says manifest none and writes no manifest for an untracked file", async () => {
    const af = join(desktop, "plain.af");
    writeFileSync(af, "BYTES");
    stubOpen();
    const r = await runCommand(cmds["doc open"], [af]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("manifest: none");
    expect(r.stdout).not.toContain("madeBy:");
    expect(existsSync(af + ".axi.json")).toBe(false);
  });

  it("appends an open history entry and leaves af.sha256 and unknown keys alone", async () => {
    const af = seed("promo.af", { extra: { custom: { keep: true } } });
    const before = manifestOf(af);
    stubOpen();
    await runCommand(cmds["doc open"], [af]);
    const after = manifestOf(af);
    expect(after.af).toEqual(before.af);
    expect(after.history.at(-1)!.kind).toBe("open");
    expect(after.history).toHaveLength(before.history.length + 1);
    expect(after["custom"]).toEqual({ keep: true });
  });

  it("rejects a path outside the Desktop with exit 2 before any load", async () => {
    const af = join(root, "elsewhere.af");
    writeFileSync(af, "BYTES");
    stubOpen();
    const r = await runCommand(cmds["doc open"], [af]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("outside the Desktop folder");
    expect(marked("doc-open")).toHaveLength(0);
  });

  it("rejects a path inside a hidden folder with exit 2 before connecting", async () => {
    mkdirSync(join(desktop, ".work"));
    const af = join(desktop, ".work", "a.af");
    writeFileSync(af, "BYTES");
    stubOpen();
    const r = await runCommand(cmds["doc open"], [af]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("inside a hidden folder or file ('.work')");
    expect(server.sessionsOpened()).toBe(0);
  });

  it("rejects a non-.af path and a missing file with exit 2 before connecting", async () => {
    const png = await runCommand(cmds["doc open"], [join(desktop, "x.png")]);
    expect(png.code).toBe(2);
    expect(png.stdout).toContain("must end in .af");
    const missing = await runCommand(cmds["doc open"], [join(desktop, "nope.af")]);
    expect(missing.code).toBe(2);
    expect(missing.stdout).toContain("no such file");
    expect(server.sessionsOpened()).toBe(0);
  });

  it("a load failure is exit 1 with the reason", async () => {
    const af = seed("promo.af");
    stubOpen("error");
    const r = await runCommand(cmds["doc open"], [af]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("cannot read file");
  });

  it("an unreadable inventory does not fail the open", async () => {
    const af = seed("promo.af");
    server.onScript("affinity-axi:doc-open", JSON.stringify({ status: "opened", uuid: FIXTURE_UUID_2, title: "promo.af", dirty: false }));
    server.onScript("getSpreadVisibleBox", "not json");
    const r = await runCommand(cmds["doc open"], [af]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("named[2]: bg, headline"); // falls back to the manifest's inventory
  });
});

describe("doc info", () => {
  it("is offline: zero connections, fresh summary with counts", async () => {
    const af = seed("promo.af", { madeBy: true });
    const r = await runCommand(cmds["doc info"], [af]);
    expect(r.code).toBe(0);
    expect(server.sessionsOpened()).toBe(0);
    expect(r.stdout).toContain("manifest: fresh");
    expect(r.stdout).toContain("madeBy: scripts/promo.js");
    expect(r.stdout).toContain("named[2]: bg, headline");
    expect(r.stdout).toContain("history: 1");
    expect(r.stdout).toContain("exports: 0");
    expect(r.stdout).toContain("notes: 0");
    expect(r.stdout).toContain("doc open ");
  });

  describe("brand line", () => {
    const KIT = '{"name":"Acme"}';
    const sha = (t: string) => createHash("sha256").update(t).digest("hex");
    /** A kit at <root>/brands and an asset in <desktop>/sub whose manifest records `path`. */
    function seedBrand(path: string): string {
      mkdirSync(join(root, "brands"), { recursive: true });
      writeFileSync(join(root, "brands", "acme.brand.json"), KIT);
      mkdirSync(join(desktop, "sub"), { recursive: true });
      const madeBy = { script: "scripts/promo.js", scriptSha256: "abc", args: {}, flags: [], brand: { name: "Acme", path, sha256: sha(KIT) } };
      return seed("sub/promo.af", { extra: { madeBy } });
    }
    const info = async (af: string, cwd: string) => {
      const prev = process.cwd();
      process.chdir(cwd);
      try {
        return await runCommand(cmds["doc info"], [af]);
      } finally {
        process.chdir(prev);
      }
    };

    it("resolves against the manifest folder: no (changed) from the root or the sub-folder", async () => {
      const af = seedBrand("../../brands/acme.brand.json");
      for (const cwd of [root, join(desktop, "sub")]) {
        const r = await info(af, cwd);
        expect(r.stdout).toContain("brand: Acme (../../brands/acme.brand.json)");
        expect(r.stdout).not.toContain("(changed)");
      }
    });

    it("prints (changed) from both places once the kit is edited", async () => {
      const af = seedBrand("../../brands/acme.brand.json");
      writeFileSync(join(root, "brands", "acme.brand.json"), '{"name":"Acme","v":2}');
      for (const cwd of [root, join(desktop, "sub")]) {
        const r = await info(af, cwd);
        expect(r.stdout).toContain("brand: Acme (../../brands/acme.brand.json) (changed)");
      }
    });

    it("still resolves an older cwd-relative path from the matching cwd", async () => {
      const af = seedBrand("brands/acme.brand.json");
      const ok = await info(af, root);
      expect(ok.stdout).toContain("brand: Acme (brands/acme.brand.json)");
      expect(ok.stdout).not.toContain("(changed)");
      writeFileSync(join(root, "brands", "acme.brand.json"), "{}");
      expect((await info(af, root)).stdout).toContain("(brands/acme.brand.json) (changed)");
    });

    it("prints the line without a suffix when the kit is missing", async () => {
      const af = seedBrand("../../brands/gone.brand.json");
      const r = await info(af, root);
      expect(r.stdout).toMatch(/^brand: Acme \(\.\.\/\.\.\/brands\/gone\.brand\.json\)$/m);
    });
  });

  it("says stale and points at doc open then inspect", async () => {
    const af = seed("promo.af", { tamper: true });
    const r = await runCommand(cmds["doc info"], [af]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`manifest: stale (changed outside affinity-axi after ${SAVED_AT})`);
    expect(r.stdout).toContain("doc open ");
    expect(r.stdout).toContain("inspect ");
    expect(server.sessionsOpened()).toBe(0);
  });

  it("manifest none for an untracked file; unknown file is exit 2", async () => {
    const af = join(desktop, "plain.af");
    writeFileSync(af, "BYTES");
    const none = await runCommand(cmds["doc info"], [af]);
    expect(none.code).toBe(0);
    expect(none.stdout).toContain("manifest: none");
    const missing = await runCommand(cmds["doc info"], [join(desktop, "nope.af")]);
    expect(missing.code).toBe(2);
  });
});

describe("doc note", () => {
  it("appends a note and keeps every other key", async () => {
    const af = seed("promo.af", { extra: { custom: { keep: true } } });
    const r = await runCommand(cmds["doc note"], [af, "client approved v2"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("notes: 1");
    const m = manifestOf(af);
    expect(m.notes.at(-1)!.text).toBe("client approved v2");
    expect(m["custom"]).toEqual({ keep: true });
    expect(m.af.sha256).toBe(createHash("sha256").update("AFFINITY-BYTES").digest("hex"));
    expect(server.sessionsOpened()).toBe(0);
    const info = await runCommand(cmds["doc info"], [af]);
    expect(info.stdout).toContain("notes: 1");
    expect(info.stdout).toContain("lastNote: client approved v2");
  });

  it("without a manifest it is exit 1 and writes nothing; an empty note is exit 2", async () => {
    const af = join(desktop, "plain.af");
    writeFileSync(af, "BYTES");
    const r = await runCommand(cmds["doc note"], [af, "hello"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("no manifest");
    expect(existsSync(af + ".axi.json")).toBe(false);
    const seeded = seed("promo.af");
    const empty = await runCommand(cmds["doc note"], [seeded, "  "]);
    expect(empty.code).toBe(2);
  });
});

describe("partial manifest (hand-truncated)", () => {
  /** A syntactically valid manifest with none of the arrays. */
  function seedPartial(name: string): string {
    const af = join(desktop, name);
    writeFileSync(af, "AFFINITY-BYTES");
    writeFileSync(af + ".axi.json", JSON.stringify({ schema: "affinity-axi/manifest/1", file: name }) + "\n");
    return af;
  }

  it("doc info reads it offline: exit 0, none, zero counts", async () => {
    const af = seedPartial("cut.af");
    const r = await runCommand(cmds["doc info"], [af]);
    expect(r.code).toBe(0);
    expect(server.sessionsOpened()).toBe(0);
    expect(r.stdout).toContain("manifest: none");
    expect(r.stdout).toContain("notes: 0");
    expect(r.stdout).toContain("history: 0");
  });

  it("doc note appends to it and leaves all arrays in the written file", async () => {
    const af = seedPartial("cut.af");
    const r = await runCommand(cmds["doc note"], [af, "first note"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("notes: 1");
    const m = manifestOf(af);
    expect(m.notes.map((n) => n.text)).toEqual(["first note"]);
    expect(m.history).toEqual([]);
    expect(m.exports).toEqual([]);
    expect(m.ai).toEqual({ generated: false, records: 0, uuids: [] });
    expect(m.madeBy).toBeNull();
  });

  it("doc open appends the open entry instead of failing", async () => {
    const af = seedPartial("cut.af");
    stubOpen();
    const r = await runCommand(cmds["doc open"], [af]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("status: opened");
    expect(manifestOf(af).history.map((h) => h.kind)).toEqual(["open"]);
  });
});
