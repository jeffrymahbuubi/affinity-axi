// `fill --hide-missing`: planning, the hide script lines (evaluated with node:vm against stub rows) and the
// command (fake MCP server; no Affinity).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HIDE_MISSING_LINES } from "../src/affinity/fill-hide.js";
import { FILL_APPLY, planEdits, type ApplyReply, type Edit } from "../src/affinity/fill-script.js";
import { readRuns } from "../src/affinity/runlog.js";
import { make } from "../src/commands/fill.js";
import { dispatch } from "../src/cli/router.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_APP } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

describe("planEdits with hideMissing", () => {
  it("null, empty and blank values become hidden edits", () => {
    const rec = { a: null, b: "", c: "  ", d: "x" };
    const e = planEdits(rec, undefined, ".", { hideMissing: true });
    expect(e.slice(0, 3)).toEqual([
      { key: "a", ref: "slot:a", hidden: true },
      { key: "b", ref: "slot:b", hidden: true },
      { key: "c", ref: "slot:c", hidden: true },
    ]);
    expect(e[3]).toMatchObject({ key: "d", str: "x" });
  });

  it("without it null still throws and an empty string is still a text edit", () => {
    expect(() => planEdits({ a: null }, undefined, ".")).toThrow();
    expect(planEdits({ b: "" }, undefined, ".")).toEqual([{ key: "b", ref: "slot:b", str: "" }]);
  });
});

interface Row { name: string; artboard: string; node: { hidden: boolean } }

function run(rows: Row[], edits: Array<Partial<Edit>>, throwAfter = Infinity): { out: { hidden: string[] }; hiddenNames: string[] } {
  let calls = 0;
  const out = { hidden: [] as string[] };
  const ctx = {
    out,
    edits,
    doc: { executeCommand: (c: { node: { hidden: boolean } }) => { if (++calls > throwAfter) throw new Error("boom"); c.node.hidden = true; } },
    axiRows: () => rows,
    DocumentCommand: { createSetVisibility: (sel: { node: { hidden: boolean } }) => sel },
    Selection: { create: (_d: unknown, node: { hidden: boolean }) => ({ node }) },
  };
  runInNewContext(`{\n${HIDE_MISSING_LINES.join("\n")}\n}`, ctx);
  return { out, hiddenNames: rows.filter((r) => r.node.hidden).map((r) => `${r.artboard}/${r.name}`) };
}

const row = (name: string, artboard = "og"): Row => ({ name, artboard, node: { hidden: false } });

describe("hide lines", () => {
  it("hides uncovered slots and their with: rows, leaves covered ones", () => {
    const rows = [row("slot:p1"), row("with:p1"), row("slot:p4"), row("with:p4"), row("slot:p5"), row("with:p5")];
    const r = run(rows, [{ ref: "slot:p1", str: "x" }]);
    expect(r.hiddenNames).toEqual(["og/slot:p4", "og/with:p4", "og/slot:p5", "og/with:p5"]);
    expect(r.out.hidden).toEqual(["p4", "p5"]);
  });

  it("a blanked slot (hidden edit) hides its with: rows too", () => {
    const rows = [row("slot:p4"), row("with:p4")];
    const r = run(rows, [{ ref: "slot:p4", hidden: true }]);
    expect(r.hiddenNames).toEqual(["og/with:p4"]);
    expect(r.out.hidden).toEqual(["p4"]);
  });

  it("an artboard-qualified edit covers only that board", () => {
    const rows = [row("slot:p4", "og"), row("with:p4", "og"), row("slot:p4", "ig"), row("with:p4", "ig")];
    const r = run(rows, [{ ref: "og/slot:p4", str: "x" }]);
    expect(r.hiddenNames).toEqual(["ig/slot:p4", "ig/with:p4"]);
    expect(r.out.hidden).toEqual(["ig/p4"]);
  });

  it("an exception part-way propagates (the apply script's catch then undoes)", () => {
    const rows = [row("slot:a"), row("slot:b"), row("slot:c")];
    expect(() => run(rows, [], 2)).toThrow("boom");
    expect(rows.filter((r) => r.node.hidden)).toHaveLength(2);
  });
});

describe("FILL_APPLY script", () => {
  const edits: Edit[] = [{ key: "a", ref: "slot:a", str: "x" }];
  it("holds the hide block only with the flag, inside the try before the catch, and not when blocked", () => {
    const on = FILL_APPLY("0123456789ABCDEF", edits, false, true);
    const off = FILL_APPLY("0123456789ABCDEF", edits, false);
    expect(on).toContain("out.hidden = [];");
    expect(off).not.toContain("hideRows");
    expect(on).toBe(off.replace("    });\n  } catch (e) {", `    });\n${HIDE_MISSING_LINES.join("\n")}\n  } catch (e) {`));
    expect(on.indexOf("if (!blocked) {")).toBeLessThan(on.indexOf("hideRows"));
    expect(on.indexOf("doc.undo()")).toBeGreaterThan(on.indexOf("hideRows"));
  });
});

describe("fill --hide-missing (command)", () => {
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
    root = mkdtempSync(join(tmpdir(), "axi-fill-hide-"));
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

  const scripts = (): string[] => server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"]));

  function setup(hidden?: string[]): { template: string; data: string; out: string } {
    const reply: ApplyReply = { applied: ["p1"], unknown: [], duplicate: [], mismatch: [], slots: ["slot:p1", "slot:p4"], notes: [], ...(hidden ? { hidden } : {}) };
    server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
    server.onScript("affinity-axi:fill-open", JSON.stringify({ status: "loaded", uuid: "00000000-0000-4000-8000-000000000001" }));
    server.onScript("affinity-axi:fill-apply", JSON.stringify(reply));
    server.onScript("affinity-axi:doc-save", (script) => {
      const path = JSON.parse(/const outPath = (".*");/.exec(script)![1]!) as string;
      writeFileSync(path, "af");
      return JSON.stringify({ status: "saved", uuid: "x", path, dirty: false });
    });
    server.onScript("affinity-axi:doc-close", JSON.stringify({ status: "closed", uuid: "x" }));
    const template = join(desktop, "post.af");
    writeFileSync(template, "template");
    const data = join(work, "d.json");
    writeFileSync(data, JSON.stringify([{ slug: "a", p1: "Hi" }]));
    return { template, data, out: join(desktop, "out") };
  }

  it("with the flag: the script has the hide block, the row note and the run log carry it", async () => {
    const { template, data, out } = setup(["p4", "p5"]);
    const r = await runCommand(fill, [template, "--data", data, "--key", "slug", "--out-dir", out, "--hide-missing"]);
    expect(r.code).toBe(0);
    expect(scripts().find((s) => s.includes("fill-apply"))).toContain("hideRows");
    expect(r.stdout).toContain("hidden: p4, p5");
    expect(readRuns(work)[0]!.flags).toContain("--hide-missing");
  });

  it("without the flag: no hide block, no note", async () => {
    const { template, data, out } = setup();
    const r = await runCommand(fill, [template, "--data", data, "--key", "slug", "--out-dir", out]);
    expect(r.code).toBe(0);
    expect(scripts().find((s) => s.includes("fill-apply"))).not.toContain("hideRows");
    expect(r.stdout).not.toContain("hidden:");
  });

  it("--help shows the flag and the data wording", async () => {
    const root0 = { spec: { name: "root", summary: "r", args: [], flags: [], examples: [] }, run: () => 0 };
    const reg = { tool: "affinity-axi", root: root0, rootHelp: () => "", commands: { fill }, aliases: {} };
    const chunks: string[] = [];
    const w = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => (chunks.push(String(s)), true)) as typeof process.stdout.write;
    try {
      await dispatch(reg, ["fill", "--help"]);
    } finally {
      process.stdout.write = w;
    }
    const text = chunks.join("");
    expect(text).toContain("--hide-missing");
    expect(text).toContain("(with --hide-missing both hide the slot)");
  });
});
