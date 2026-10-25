// doc new / doc save / doc close, in-process against the fake MCP server.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { make } from "../src/commands/doc.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_APP, FIXTURE_DOCS, FIXTURE_UUID, FIXTURE_UUID_2 } from "./fake-mcp/fixtures.js";
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
  root = mkdtempSync(join(tmpdir(), "axi-doc-"));
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

function stubDocs(docs = FIXTURE_DOCS, current: string | null = FIXTURE_UUID): void {
  server.onScript("affinity-axi:list-documents", JSON.stringify({ current, documents: docs }));
}

describe("doc (module)", () => {
  it("exports the three commands with marker-bearing scripts", () => {
    expect(Object.keys(cmds).sort()).toEqual(["doc close", "doc new", "doc save"]);
    for (const [k, c] of Object.entries(cmds)) expect(c.spec.name).toBe(k);
  });
});

describe("doc new", () => {
  const reply = { uuid: FIXTURE_UUID_2, title: "<Untitled>", dirty: false, units: "Pixel", width: 800, height: 600, dpi: 72 };

  it("creates a pixel document at 72 dpi by default and prints doc, size and help", async () => {
    server.onScript("affinity-axi:doc-new", JSON.stringify(reply));
    const r = await runCommand(cmds["doc new"], ["--width", "800", "--height", "600"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`doc: ${FIXTURE_UUID_2}`);
    expect(r.stdout).toContain("size: 800x600 px @ 72 dpi");
    expect(r.stdout).toMatch(/help\[3\]:/);
    expect(r.stdout).toContain("run ");
    expect(r.stdout).toContain("render 01E35352");
    expect(r.stdout).toContain("doc save 01E35352");
    const s = marked("doc-new")[0]!;
    expect(s).toContain("o.width = 800; o.height = 600; o.dpi = 72;");
    expect(s).toContain('"Pixel"');
  });

  it("defaults to 300 dpi for print units", async () => {
    server.onScript("affinity-axi:doc-new", JSON.stringify({ ...reply, dpi: 300 }));
    const r = await runCommand(cmds["doc new"], ["--width", "210", "--height", "297", "--units", "mm"]);
    expect(r.code).toBe(0);
    const s = marked("doc-new")[0]!;
    expect(s).toContain("o.dpi = 300;");
    expect(s).toContain('"Millimetre"');
  });

  it("accepts a decimal size", async () => {
    server.onScript("affinity-axi:doc-new", JSON.stringify({ ...reply, dpi: 300 }));
    const r = await runCommand(cmds["doc new"], ["--width", "8.5", "--height", "11", "--units", "mm"]);
    expect(r.code).toBe(0);
    expect(marked("doc-new")[0]!).toContain("o.width = 8.5; o.height = 11; o.dpi = 300;");
  });

  it("rejects missing or invalid sizes with exit 2 before connecting", async () => {
    for (const argv of [[], ["--width", "800"], ["--width", "0", "--height", "5"], ["--width", "abc", "--height", "5"], ["--width", "0x10", "--height", "5"], ["--width", "1e3", "--height", "5"], ["--width", "5", "--height", "5", "--dpi", "-1"]]) {
      const r = await runCommand(cmds["doc new"], argv);
      expect(r.code).toBe(2);
      expect(r.stdout).toContain("error:");
    }
    expect(server.sessionsOpened()).toBe(0);
  });
});

describe("doc save", () => {
  const target = () => join(desktop, "proj", "test.af");

  function stubSave(dirty = false): void {
    server.onScript("affinity-axi:doc-save", (script) => {
      const m = /const outPath = ("(?:[^"\\]|\\.)*");/.exec(script)!;
      const p = JSON.parse(m[1]!) as string;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, "AFFINITY-BYTES");
      return JSON.stringify({ status: "saved", uuid: FIXTURE_UUID, path: p, dirty });
    });
  }

  it("rejects a non-.af path with exit 2 before connecting", async () => {
    const r = await runCommand(cmds["doc save"], ["current", join(desktop, "x.png")]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("must end in .af");
    expect(server.sessionsOpened()).toBe(0);
  });

  it("rejects a path outside the Desktop with exit 2 and never calls saveAs", async () => {
    stubDocs();
    const r = await runCommand(cmds["doc save"], ["current", join(root, "elsewhere.af")]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("outside the Desktop folder");
    expect(marked("doc-save")).toHaveLength(0);
  });

  it("rejects a path inside a hidden folder or a hidden file name before connecting", async () => {
    const folder = join(desktop, ".cache", "x.af");
    const r = await runCommand(cmds["doc save"], ["current", folder]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("inside a hidden folder or file ('.cache')");
    expect(server.sessionsOpened()).toBe(0);
    expect(existsSync(folder)).toBe(false);
    const file = await runCommand(cmds["doc save"], ["current", join(desktop, ".x.af")]);
    expect(file.code).toBe(2);
    expect(file.stdout).toContain("('.x.af')");
    expect(server.sessionsOpened()).toBe(0);
  });

  it("rejects .. escapes out of the Desktop", async () => {
    stubDocs();
    const r = await runCommand(cmds["doc save"], ["current", join(desktop, "..", "evil.af")]);
    expect(r.code).toBe(2);
    expect(marked("doc-save")).toHaveLength(0);
  });

  it("saves, creating the folder, and prints saved/doc/bytes/dirty", async () => {
    stubDocs();
    stubSave();
    const r = await runCommand(cmds["doc save"], ["current", target()]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`saved: ${target()}`);
    expect(r.stdout).toContain(`doc: ${FIXTURE_UUID}`);
    expect(r.stdout).toContain("bytes: 14");
    expect(r.stdout).toContain("dirty: false");
    expect(r.stdout).toContain("doc close 70E876CB");
    expect(existsSync(target())).toBe(true);
    const s = marked("doc-save")[0]!;
    expect(s).toContain(`const targetUuid = "${FIXTURE_UUID}";`);
    expect(s).toContain("doc.saveAs(outPath)");
  });

  it("is idempotent: a clean document already at that path is a no-op exit 0 that says so", async () => {
    const p = target();
    // the document lives at p (its own path), so the missing manifest is no refusal
    stubDocs([{ ...FIXTURE_DOCS[0]!, dirty: false, path: p }, FIXTURE_DOCS[1]!]);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "AFFINITY-BYTES");
    server.onScript("affinity-axi:doc-save", JSON.stringify({ status: "unchanged", uuid: FIXTURE_UUID, path: p, dirty: false }));
    const r = await runCommand(cmds["doc save"], ["current", p]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("already saved and clean");
    expect(r.stdout).toContain("dirty: false");
    // the guard lives in the script itself
    expect(marked("doc-save")[0]!).toContain("!doc.isDirty && String(doc.path || '') === outPath");
  });

  it("resolves a UUID prefix and reports an unknown document as exit 2", async () => {
    stubDocs();
    stubSave();
    const ok = await runCommand(cmds["doc save"], ["01E35352", target()]);
    expect(ok.code).toBe(0);
    expect(marked("doc-save")[0]!).toContain(FIXTURE_UUID_2);
    const bad = await runCommand(cmds["doc save"], ["DEADBEEF", target()]);
    expect(bad.code).toBe(2);
    expect(bad.stdout).toContain("no open document matches");
  });

  it("fails when the file was not written", async () => {
    stubDocs();
    server.onScript("affinity-axi:doc-save", JSON.stringify({ status: "saved", uuid: FIXTURE_UUID, path: target(), dirty: false }));
    const r = await runCommand(cmds["doc save"], ["current", target()]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("was not written");
  });
});

describe("doc save manifest hook and stale refusal", () => {
  const af = () => join(desktop, "proj", "promo.af");
  const SAVED_AT = "2026-10-24T13:02:11.000Z";
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");

  /** An .af with a manifest bound to "ORIGINAL" bytes; `edited` leaves different bytes on disk (stale). */
  function seed(edited: boolean): void {
    mkdirSync(dirname(af()), { recursive: true });
    writeFileSync(af(), edited ? "HAND-EDITED" : "ORIGINAL");
    const m = {
      schema: "affinity-axi/manifest/1",
      file: "promo.af",
      af: { sha256: sha("ORIGINAL"), bytes: 8, savedAt: SAVED_AT, tool: "affinity-axi 0.1.0" },
      madeBy: null,
      history: [{ time: SAVED_AT, kind: "save" }],
      exports: [],
      ai: { generated: false, records: 0 },
      inventory: null,
      notes: [],
    };
    writeFileSync(af() + ".axi.json", JSON.stringify(m));
  }

  function stubSave(): void {
    stubDocs();
    server.onScript("affinity-axi:doc-save", (script) => {
      const p = JSON.parse(/const outPath = ("(?:[^"\\]|\\.)*");/.exec(script)![1]!) as string;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, "NEW-BYTES");
      return JSON.stringify({ status: "saved", uuid: FIXTURE_UUID, path: p, dirty: false });
    });
  }

  const manifest = () =>
    JSON.parse(readFileSync(af() + ".axi.json", "utf8")) as {
      af: { sha256: string };
      history: Array<Record<string, unknown>>;
      inventory: { counts: { named: number } } | null;
    };

  it("refuses to overwrite a stale file: exit 1, zero fake calls, bytes unchanged, suggestion names doc open, inspect and --force", async () => {
    seed(true);
    stubSave();
    const r = await runCommand(cmds["doc save"], ["current", af()]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`error: promo.af was changed outside affinity-axi after ${SAVED_AT}; refusing to overwrite`);
    expect(r.stdout).toContain("suggestion:");
    expect(r.stdout).toContain("doc open");
    expect(r.stdout).toContain("inspect current --named");
    expect(r.stdout).toContain("--force");
    expect(server.calls).toHaveLength(0);
    expect(server.sessionsOpened()).toBe(0);
    expect(readFileSync(af(), "utf8")).toBe("HAND-EDITED");
  });

  it("--force overwrites and the last history entry is the save with forced: true", async () => {
    seed(true);
    stubSave();
    const r = await runCommand(cmds["doc save"], ["current", af(), "--force"]);
    expect(r.code).toBe(0);
    expect(readFileSync(af(), "utf8")).toBe("NEW-BYTES");
    const m = manifest();
    expect(m.history.at(-1)).toMatchObject({ kind: "save", forced: true });
    expect(m.af.sha256).toBe(sha("NEW-BYTES"));
  });

  it("a fresh manifest saves without a flag and the save entry is not forced", async () => {
    seed(false);
    stubSave();
    const r = await runCommand(cmds["doc save"], ["current", af()]);
    expect(r.code).toBe(0);
    const last = manifest().history.at(-1)!;
    expect(last["kind"]).toBe("save");
    expect(last["forced"]).toBeUndefined();
    expect(manifest().af.sha256).toBe(sha("NEW-BYTES"));
  });

  it("a file with no manifest saves without a flag and gets a manifest with the inventory", async () => {
    stubSave();
    server.onScript("getSpreadVisibleBox", JSON.stringify({
      at: SAVED_AT,
      doc: { uuid: FIXTURE_UUID, title: "t", path: "", units: "Pixel", width: 1, height: 1, dpi: 72 },
      artboards: [],
      nodes: [{ path: "0/0", type: "Rectangle", name: "cta", box: [0, 0, 1, 1], visible: true }],
      counts: { nodes: 1, named: 1, text: 0, images: 0 },
    }));
    const r = await runCommand(cmds["doc save"], ["current", af()]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("manifest: promo.af.axi.json");
    expect(manifest().inventory!.counts.named).toBe(1);
    expect(manifest().history.at(-1)).toMatchObject({ kind: "save" });
  });

  it("refuses to overwrite an existing .af that has no manifest", async () => {
    mkdirSync(dirname(af()), { recursive: true });
    writeFileSync(af(), "MADE-BY-HAND");
    stubSave();
    const r = await runCommand(cmds["doc save"], ["current", af()]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("error: promo.af exists and was not saved by affinity-axi (no manifest); refusing to overwrite");
    expect(r.stdout).toContain("suggestion:");
    expect(r.stdout).toContain("--force");
    expect(r.stdout).toContain("doc open");
    expect(readFileSync(af(), "utf8")).toBe("MADE-BY-HAND");
    expect(existsSync(af() + ".axi.json")).toBe(false);
    expect(server.calls.filter((c) => c.name === "execute_script" && String(c.args["script"]).includes("list-documents"))).toHaveLength(1);
    expect(marked("doc-save")).toHaveLength(0);
  });

  it("saves back to the document's own path without a flag, creating a manifest that is not forced", async () => {
    mkdirSync(dirname(af()), { recursive: true });
    writeFileSync(af(), "OPENED-BY-HAND");
    // handlers match first-registered-first, so register the document list before stubSave()
    stubDocs([{ ...FIXTURE_DOCS[0]!, path: af() }, FIXTURE_DOCS[1]!]);
    stubSave();
    const r = await runCommand(cmds["doc save"], ["current", af()]);
    expect(r.code).toBe(0);
    expect(readFileSync(af(), "utf8")).toBe("NEW-BYTES");
    expect(r.stdout).not.toContain("(forced)");
    const last = manifest().history.at(-1)!;
    expect(last["kind"]).toBe("save");
    expect(last["forced"]).toBeUndefined();
    expect(manifest().af.sha256).toBe(sha("NEW-BYTES"));
  });

  it("--force replaces an unmanaged file and records forced: true", async () => {
    mkdirSync(dirname(af()), { recursive: true });
    writeFileSync(af(), "MADE-BY-HAND");
    stubSave();
    const r = await runCommand(cmds["doc save"], ["current", af(), "--force"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("promo.af.axi.json (forced)");
    expect(readFileSync(af(), "utf8")).toBe("NEW-BYTES");
    expect(manifest().history.at(-1)).toMatchObject({ kind: "save", forced: true });
  });

  it("--force on a fresh file is not recorded as forced", async () => {
    seed(false);
    stubSave();
    const r = await runCommand(cmds["doc save"], ["current", af(), "--force"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("(forced)");
    expect(manifest().history.at(-1)!["forced"]).toBeUndefined();
  });

  it("the extension check still comes first (non-.af stays exit 2 before connecting)", async () => {
    const r = await runCommand(cmds["doc save"], ["current", join(desktop, "x.png")]);
    expect(r.code).toBe(2);
    expect(server.sessionsOpened()).toBe(0);
  });
});

describe("doc close", () => {
  it("refuses a dirty document with exit 1, before any close script, and suggests doc save", async () => {
    stubDocs(); // FIXTURE_UUID is dirty
    const r = await runCommand(cmds["doc close"], ["current"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("unsaved changes");
    expect(r.stdout).toContain("doc save 70E876CB <path-under-Desktop>.af");
    expect(r.stdout).toContain("cannot discard");
    expect(marked("doc-close")).toHaveLength(0);
    expect(scripts().some((s) => s.includes(".close("))).toBe(false);
  });

  it("closes a clean document and prints closed: <uuid>", async () => {
    stubDocs();
    server.onScript("affinity-axi:doc-close", JSON.stringify({ status: "closed", uuid: FIXTURE_UUID_2 }));
    const r = await runCommand(cmds["doc close"], ["01E35352"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`closed: ${FIXTURE_UUID_2}\n`);
    expect(marked("doc-close")).toHaveLength(1);
  });

  it("script text: isDirty check precedes close(), and close() sits only in the clean branch", async () => {
    stubDocs();
    server.onScript("affinity-axi:doc-close", JSON.stringify({ status: "closed", uuid: FIXTURE_UUID_2 }));
    await runCommand(cmds["doc close"], ["01E35352"]);
    const s = marked("doc-close")[0]!;
    expect(s.split(".close(")).toHaveLength(2);
    expect(s.indexOf("doc.isDirty")).toBeGreaterThan(-1);
    expect(s.indexOf("doc.isDirty")).toBeLessThan(s.indexOf(".close("));
    expect(s).toMatch(/else if \(doc\.isDirty\) \{ console\.log\([^\n]*status: 'dirty'[^\n]*\n\s*else \{\n\s*doc\.close\(\);/);
  });

  it("refuses if the script finds the document dirty after a clean listing (race)", async () => {
    stubDocs();
    server.onScript("affinity-axi:doc-close", JSON.stringify({ status: "dirty", uuid: FIXTURE_UUID_2 }));
    const r = await runCommand(cmds["doc close"], ["01E35352"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("unsaved changes");
  });

  it("an unknown or already-closed document lists the candidates and exits 2", async () => {
    stubDocs();
    const unknown = await runCommand(cmds["doc close"], ["DEADBEEF"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stdout).toContain("no open document matches");
    expect(unknown.stdout).toContain(FIXTURE_UUID_2);
    const short = await runCommand(cmds["doc close"], ["abc"]);
    expect(short.code).toBe(2);
    expect(marked("doc-close")).toHaveLength(0);
  });

  it("current with no focused document is exit 2", async () => {
    stubDocs(FIXTURE_DOCS, null);
    const r = await runCommand(cmds["doc close"], ["current"]);
    expect(r.code).toBe(2);
  });

  it("reports a document that is still open after close as an error", async () => {
    stubDocs();
    server.onScript("affinity-axi:doc-close", JSON.stringify({ status: "still-open", uuid: FIXTURE_UUID_2 }));
    const r = await runCommand(cmds["doc close"], ["01E35352"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("still open");
  });
});
