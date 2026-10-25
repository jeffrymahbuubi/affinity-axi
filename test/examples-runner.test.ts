// The examples runner against a stub bin (a tiny node script that keeps its
// state in a JSON file), the gallery checker, and the check script.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { EXAMPLES } from "../src/examples/registry.js";
import type { Example } from "../src/examples/types.js";
import {
  checkGallery,
  displayCommand,
  inputFiles,
  isSideEffect,
  parseCommandPaths,
  renderCommandSh,
  renderReadme,
  runExample,
  substitute,
  tokenize,
  withOutArg,
} from "../src/examples/runner.js";

const toolDir = fileURLToPath(new URL("..", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "axi-runner-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const DEMO = "AAAAAAAA-1111-2222-3333-444444444444";
const EXTRA = "BBBBBBBB-1111-2222-3333-444444444444";

const STUB = `
const fs = require('fs');
const st = process.env.STUB_STATE;
const s = fs.existsSync(st) ? JSON.parse(fs.readFileSync(st, 'utf8')) : { open: [], log: [] };
const argv = process.argv.slice(2);
s.log.push(argv.join(' '));
const save = () => fs.writeFileSync(st, JSON.stringify(s));
const [cmd, sub] = argv;
if (!cmd) {
  console.log('affinity: connected');
  if (process.env.STUB_HOME === 'unavailable') {
    console.log('documents: unavailable (script call failed)');
  } else {
    console.log('documents[' + s.open.length + ']{uuid,title,dirty,units}:');
    for (const u of s.open) console.log('  ' + u + ',<Untitled>,true,Pixel');
  }
} else if (cmd === 'run' && argv[1].endsWith('demo-doc.js')) {
  s.open.push('${DEMO}');
  console.log('{"uuid":"${DEMO}"}');
} else if (cmd === 'render') {
  console.log('render: out.jpg');
  console.log('doc: ${DEMO}');
  console.log('bytes: 4321');
  if (argv.includes('--out')) fs.writeFileSync(argv[argv.indexOf('--out') + 1], 'jpg');
} else if (cmd === 'doc' && sub === 'new') {
  s.open.push('${EXTRA}');
  console.log('doc: ${EXTRA}');
} else if (cmd === 'doc' && sub === 'save') {
  if (process.env.STUB_SAVE === 'fail') {
    save();
    console.log('error: boom');
    process.exit(1);
  }
  if (process.env.STUB_SAVE === 'missing') {
    save();
    console.log('error: no open document matches "AAAAAAAA"');
    process.exit(2);
  }
  console.log('bytes: 12');
} else if (cmd === 'doc' && sub === 'close') {
  s.open = s.open.filter((u) => !u.startsWith(argv[2].toUpperCase()));
  console.log('closed');
} else if (cmd === 'batch') {
  console.log('batch[1]{key,status,doc,ms,note}:');
  console.log('  a,ok,DEADBEEF,5,"x, y"');
} else if (cmd === 'slow') {
  save();
  setTimeout(() => {}, 20000);
  return;
} else if (cmd === 'fail') {
  save();
  console.log('error: boom');
  process.exit(1);
} else {
  console.log('echo: ' + argv.join(' '));
}
save();
`;

const stubBin = join(tmp, "stub-bin.cjs");
writeFileSync(stubBin, `(function () {${STUB}})();`);
const state = join(tmp, "state.json");

function ex(over: Partial<Example>): Example {
  return { id: "t", feature: "t", title: "T", summary: "s", commands: ["$BIN render $DOC"], output: ["render: out.jpg"], images: [], needs: ["affinity", "document"], ...over };
}

function opts(id: string, extra: Record<string, unknown> = {}) {
  const outDir = join(tmp, "work", id);
  return { bin: stubBin, cwd: tmp, outDir, demoScript: join(tmp, "demo-doc.js"), env: { STUB_STATE: state }, ...extra };
}

const log = (): string[] => JSON.parse(readFileSync(state, "utf8")).log as string[];
const open = (): string[] => JSON.parse(readFileSync(state, "utf8")).open as string[];

beforeEach(() => rmSync(state, { force: true }));

describe("tokenize, substitute, withOutArg", () => {
  it("splits like a shell: quotes group, empty quotes keep an empty token", () => {
    expect(tokenize(`$BIN run a.js --args '{"uuid":"$DOC"}'`)).toEqual(["$BIN", "run", "a.js", "--args", '{"uuid":"$DOC"}']);
    expect(tokenize(`x "two words" ''  y`)).toEqual(["x", "two words", "", "y"]);
    expect(() => tokenize(`x "open`)).toThrow(/unterminated/);
  });

  it("substitutes $DOC and $OUT inside a token without splitting on spaces", () => {
    expect(substitute("$OUT/{name}.png", { doc: "ABCD1234", out: "/a b/c" })).toBe("/a b/c/{name}.png");
    expect(substitute('{"uuid":"$DOC"}', { doc: "ABCD1234", out: "x" })).toBe('{"uuid":"ABCD1234"}');
  });

  it("adds out to --args objects only, once", () => {
    expect(withOutArg(["run", "a.js", "--args", '{"uuid":"X"}'], "/o")).toEqual(["run", "a.js", "--args", '{"uuid":"X","out":"/o"}']);
    expect(withOutArg(["run", "a.js", "--args", '{"out":"keep"}'], "/o")[3]).toBe('{"out":"keep"}');
    expect(withOutArg(["run", "a.js", "--args", "[1]"], "/o")[3]).toBe("[1]");
    expect(withOutArg(["run", "a.js"], "/o")).toEqual(["run", "a.js"]);
  });

  it("shows commands with $BIN spelled out and $OUT as the gallery folder", () => {
    expect(displayCommand("$BIN export $DOC PNG $OUT/demo.png", "export")).toBe("affinity-axi export $DOC PNG examples/export/demo.png");
  });
});

describe("runExample against a stub bin", () => {
  it("makes the demo doc, runs the commands under headers, then saves and closes it", () => {
    const r = runExample(ex({ id: "render" }), opts("render"));
    expect(r.ok).toBe(true);
    expect(r.output).toContain("$ affinity-axi render $DOC\nrender: out.jpg");
    expect(r.normalised).toContain("doc: <uuid>");
    expect(r.normalised).toContain("bytes: <n>");
    const calls = log();
    expect(calls.some((c) => c.startsWith("render AAAAAAAA"))).toBe(true);
    const save = calls.findIndex((c) => c.startsWith("doc save AAAAAAAA") && c.endsWith("demo.af --force"));
    const close = calls.findIndex((c) => c === "doc close AAAAAAAA");
    expect(save).toBeGreaterThan(0);
    expect(close).toBeGreaterThan(save);
    expect(open()).toEqual([]);
  });

  it("tolerates an example that closes the document itself", () => {
    const r = runExample(ex({ id: "close", commands: ["$BIN doc save $DOC $OUT/demo.af", "$BIN doc close $DOC"] }), opts("close"));
    expect(r.ok).toBe(true);
    expect(log().filter((c) => c.startsWith("doc close"))).toHaveLength(1);
    expect(open()).toEqual([]);
  });

  it("closes the extra clean document that doc new makes", () => {
    const r = runExample(ex({ id: "new", commands: ["$BIN doc new --width 800 --height 600"], needs: ["affinity"] }), opts("new"));
    expect(r.ok).toBe(true);
    expect(log()).toContain("doc close BBBBBBBB");
    expect(open()).toEqual([]);
    expect(log().some((c) => c.startsWith("run "))).toBe(false);
  });

  it("stops at a failing command, still ends the demo doc safely, and reports it", () => {
    const r = runExample(ex({ id: "fail", commands: ["$BIN fail", "$BIN render $DOC"] }), opts("fail"));
    expect(r.ok).toBe(false);
    expect(r.failed).toMatchObject({ kind: "command", command: "affinity-axi fail" });
    expect(log().some((c) => c.startsWith("render"))).toBe(false);
    expect(open()).toEqual([]);
  });

  it("(a) still saves with --force and closes when the home table is unavailable", () => {
    const r = runExample(ex({ id: "ua", commands: ["$BIN fail"] }), opts("ua", { env: { STUB_STATE: state, STUB_HOME: "unavailable" } }));
    expect(r.ok).toBe(false);
    expect(r.failed?.kind).toBe("command");
    expect(r.failed?.leftOpen).toBeUndefined();
    const calls = log();
    const save = calls.findIndex((c) => c.startsWith("doc save AAAAAAAA") && c.endsWith("demo.af --force"));
    expect(save).toBeGreaterThan(0);
    expect(calls.indexOf("doc close AAAAAAAA")).toBeGreaterThan(save);
    expect(open()).toEqual([]);
  });

  it("(b) a failed save with the table unavailable is a cleanup failure that leaves the doc open, with no close", () => {
    const env = { STUB_STATE: state, STUB_HOME: "unavailable", STUB_SAVE: "fail" };
    const r = runExample(ex({ id: "sf" }), opts("sf", { env }));
    expect(r.ok).toBe(false);
    expect(r.failed).toMatchObject({ kind: "cleanup", leftOpen: "AAAAAAAA", message: "error: boom" });
    expect(log().some((c) => c.startsWith("doc close"))).toBe(false);
    expect(open()).toEqual([DEMO]);
  });

  it("(b) after an earlier command failure the kind stays command and leftOpen is set", () => {
    const env = { STUB_STATE: state, STUB_HOME: "unavailable", STUB_SAVE: "fail" };
    const r = runExample(ex({ id: "sf2", commands: ["$BIN fail"] }), opts("sf2", { env }));
    expect(r.failed).toMatchObject({ kind: "command", leftOpen: "AAAAAAAA" });
    expect(log().some((c) => c.startsWith("doc close"))).toBe(false);
  });

  it("(c) a save that reports no open document matches means the doc is gone", () => {
    const env = { STUB_STATE: state, STUB_HOME: "unavailable", STUB_SAVE: "missing" };
    const r = runExample(ex({ id: "sm" }), opts("sm", { env }));
    expect(r.ok).toBe(true);
    expect(r.failed).toBeUndefined();
    expect(log().some((c) => c.startsWith("doc close"))).toBe(false);
  });

  it("treats a timeout as fatal and makes no further Affinity calls", () => {
    const r = runExample(ex({ id: "slow", commands: ["$BIN slow", "$BIN render $DOC"] }), opts("slow", { timeoutMs: 1500 }));
    expect(r.ok).toBe(false);
    expect(r.failed).toMatchObject({ kind: "timeout", leftOpen: "AAAAAAAA" });
    const calls = log();
    expect(calls[calls.length - 1]).toBe("slow");
    expect(calls.some((c) => c.startsWith("doc save"))).toBe(false);
  });

  it("reports an image the commands did not produce, and finds one they did", () => {
    const missing = runExample(ex({ id: "img1", images: ["render.jpg"] }), opts("img1"));
    expect(missing.failed?.kind).toBe("images");
    const made = runExample(ex({ id: "img2", commands: ["$BIN render $DOC --out $OUT/render.jpg"], images: ["render.jpg"] }), opts("img2"));
    expect(made.ok).toBe(true);
    expect(made.images).toEqual(["render.jpg"]);
  });

  it("adds out to --args, uses a supplied demo doc without ending it, and relativises paths", () => {
    const r = runExample(ex({ id: "args", commands: [`$BIN run $OUT/script.js --args '{"uuid":"$DOC"}'`], needs: ["affinity", "document"] }), opts("args", { demoDoc: "CCCCCCCC" }));
    expect(r.ok).toBe(true);
    const call = log().find((c) => c.startsWith("run "))!;
    expect(call).toContain('"uuid":"CCCCCCCC"');
    expect(call).toContain(`"out":"${join(tmp, "work", "args")}"`);
    expect(log().some((c) => c.startsWith("doc save"))).toBe(false);
    expect(r.normalised).toContain("echo: run examples/args/script.js");
    expect(r.normalised).not.toContain(tmp);
    expect(r.normalised).toContain('"uuid":"<uuid8>"');
  });

  it("turns bare uuid8 cells in a doc column into <uuid8>", () => {
    const r = runExample(ex({ id: "cells", needs: ["affinity"], commands: ["$BIN batch"] }), opts("cells"));
    expect(r.ok).toBe(true);
    expect(r.normalised).toContain('  a,ok,<uuid8>,<n>,"x, y"');
  });
});

describe("gallery helpers", () => {
  const base = ex({ id: "render", output: ["a: 1", "b: 2"], images: ["render.jpg"], script: "script.js", needs: [] });
  const gallery = join(tmp, "gallery");
  const dir = join(gallery, "render");

  function build(output: string): void {
    rmSync(gallery, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "output.txt"), output);
    writeFileSync(join(dir, "render.jpg"), "x");
    writeFileSync(join(dir, "script.js"), "//");
  }

  it("passes when the sample lines appear in order", () => {
    build("$ affinity-axi x\na: 1\nnoise\nb: 2\n");
    expect(checkGallery([base], gallery)).toMatchObject({ errors: [], warnings: [], checked: ["render"] });
  });

  it("names the example when output.txt, a sample line, an image or the script is missing", () => {
    build("a: 1\nb: 2\n");
    rmSync(join(dir, "output.txt"));
    expect(checkGallery([base], gallery).errors[0]).toMatch(/^render: .*output\.txt is missing/);
    build("b: 2\na: 1\n");
    expect(checkGallery([base], gallery).errors[0]).toMatch(/^render: sample line missing or out of order.*b: 2/);
    build("a: 1\nb: 2\n");
    rmSync(join(dir, "render.jpg"));
    rmSync(join(dir, "script.js"));
    expect(checkGallery([base], gallery).errors).toHaveLength(2);
    expect(checkGallery([ex({ id: "nope" })], gallery).errors[0]).toMatch(/^nope: no gallery folder/);
  });

  it("warns, without failing, about an image over 500 KB", () => {
    build("a: 1\nb: 2\n");
    writeFileSync(join(dir, "render.jpg"), Buffer.alloc(600 * 1024));
    const r = checkGallery([base], gallery);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("render/render.jpg is 600 KB");
  });

  it("skips pending examples and side-effect examples that have no output yet", () => {
    build("a: 1\nb: 2\n");
    const r = checkGallery([ex({ id: "p", pending: true }), ex({ id: "hint-add" }), ex({ id: "library-save" })], gallery);
    expect(r.errors).toEqual([]);
    expect(r.skipped).toEqual(["p (pending)", "hint-add (side effects)", "library-save (side effects)"]);
    expect(isSideEffect({ id: "library-read" })).toBe(true);
    // A side-effect example with an output.txt is checked like any other.
    mkdirSync(join(gallery, "hint-add"));
    writeFileSync(join(gallery, "hint-add", "output.txt"), "other\n");
    expect(checkGallery([ex({ id: "hint-add", output: ["hint: added"] })], gallery).errors[0]).toMatch(/^hint-add:/);
  });

  it("renders command.sh, the README and the input file list", () => {
    const e = ex({ id: "render", commands: [`$BIN run $OUT/script.js --args '{"uuid":"$DOC"}'`], images: ["render.jpg"] });
    const sh = renderCommandSh(e);
    expect(sh.startsWith("#!/bin/sh\n")).toBe(true);
    expect(sh).toContain("affinity-axi run examples/render/script.js");
    expect(sh).toContain("DOC is the short id of the demo document");
    build("$ affinity-axi render $DOC\nrender: x\n\nbytes: 1\n");
    const readme = renderReadme([e, ex({ id: "later", pending: true }), ex({ id: "hint-add" }), ex({ id: "never" })], gallery);
    expect(readme).toContain("![T](render/render.jpg)");
    expect(readme).toContain("render: x");
    expect(readme).not.toContain("$ affinity-axi render $DOC\nrender: x");
    expect(readme).toContain("Not generated yet: the feature is not merged.");
    expect(readme).toContain("--include-side-effects");
    expect(readme).toContain("Not generated yet.");
    expect(inputFiles(e, dir)).toEqual(["script.js"]);
  });

  it("reads command paths from the root help table", () => {
    const help = ["affinity-axi: x", "commands[3]{command,summary}:", "  run <file.js>,Run", '  doc save <doc> <path.af>,"Save, ok"', "  presets,List", "flags[1]{flag}:", "  --brief"].join("\n");
    expect(parseCommandPaths(help)).toEqual(["run", "doc save", "presets"]);
  });
});

describe("scripts/check-examples.mjs", () => {
  const script = join(toolDir, "scripts/check-examples.mjs");
  const check = (dir: string) => spawnSync("node", [script, "--dir", dir], { encoding: "utf8" });

  /** A gallery that satisfies the real registry: sample lines, images and scripts written out. */
  function fullGallery(root: string): void {
    for (const e of EXAMPLES) {
      if (e.pending || isSideEffect(e)) continue;
      const d = join(root, e.id);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "output.txt"), e.output.join("\n") + "\n");
      for (const f of [...e.images, ...(e.script ? [e.script] : [])]) {
        mkdirSync(dirname(join(d, f)), { recursive: true });
        writeFileSync(join(d, f), "x");
      }
    }
  }

  it("fails naming render when its output.txt is removed", () => {
    const root = join(tmp, "check-a");
    fullGallery(root);
    expect(check(root).status).toBe(0);
    rmSync(join(root, "render", "output.txt"));
    const r = check(root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("error: render:");
  });

  it("warns on a 600 KB image and still exits 0", () => {
    const root = join(tmp, "check-b");
    fullGallery(root);
    writeFileSync(join(root, "render", "render.jpg"), Buffer.alloc(600 * 1024));
    const r = check(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("warning: render/render.jpg is 600 KB");
    expect(existsSync(join(root, "render", "render.jpg"))).toBe(true);
  });

  it("fails when the gallery is missing a sample line", () => {
    const root = join(tmp, "check-c");
    fullGallery(root);
    writeFileSync(join(root, "run", "output.txt"), "status: ok\n");
    const r = check(root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("error: run: sample line missing");
  });
});

describe("demo brand", () => {
  it("is Lumen Studio with Helvetica and none of the earlier client palette", () => {
    const text = readFileSync(join(toolDir, "examples/_brand/brand.json"), "utf8");
    const brand = JSON.parse(text) as { name: string; colours: Record<string, string>; fonts: Record<string, string> };
    expect(brand.name).toBe("Lumen Studio");
    expect(Object.values(brand.fonts).every((f) => f.startsWith("Helvetica"))).toBe(true);
    expect(Object.values(brand.colours).sort()).toEqual(["#1F2A44", "#4C8DFF", "#F2F5F9", "#FFC857"]);
    for (const banned of [["pulo", "sari"].join(""), ["ko", "st"].join(""), "b5553a", "6f8f7a", "e0a84a", "f6efe6"]) expect(text.toLowerCase()).not.toContain(banned);
  });

  it("keeps every example script and the demo document inside the project and the brand", () => {
    for (const e of EXAMPLES) {
      if (!e.script) continue;
      const p = join(toolDir, "examples", e.id, e.script);
      if (!existsSync(p)) continue;
      const code = readFileSync(p, "utf8");
      expect(code, e.id).not.toMatch(/Desktop|\/Users\//);
      expect(code, e.id).not.toMatch(/\bcurrent\b/);
      expect(code, e.id).not.toMatch(/\bclose\(/);
    }
    const demo = readFileSync(join(toolDir, "examples/_brand/demo-doc.js"), "utf8");
    expect(demo).toContain("axiDoc(1080, 1080)");
    expect(demo).toContain("name: 'ig-square'");
  });
});
