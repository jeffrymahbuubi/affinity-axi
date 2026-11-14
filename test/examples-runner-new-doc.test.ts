// The examples runner ends a document that `doc new` makes: close it, or save it to
// new.af when the close is refused, then close. Uses a stub bin (a tiny node script
// that keeps its state in a JSON file) with a dirty-document mode.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Example } from "../src/examples/types.js";
import { runExample } from "../src/examples/runner.js";

const tmp = mkdtempSync(join(tmpdir(), "axi-runner-newdoc-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const DEMO = "AAAAAAAA-1111-2222-3333-444444444444";
const EXTRA = "BBBBBBBB-1111-2222-3333-444444444444";

const STUB = `
const fs = require('fs');
const st = process.env.STUB_STATE;
const s = fs.existsSync(st) ? JSON.parse(fs.readFileSync(st, 'utf8')) : { open: [], dirty: [], log: [] };
const argv = process.argv.slice(2);
s.log.push(argv.join(' '));
const save = () => fs.writeFileSync(st, JSON.stringify(s));
const [cmd, sub] = argv;
if (!cmd) {
  console.log('affinity: connected');
  console.log('documents[' + s.open.length + ']{uuid,title,dirty,units}:');
  for (const u of s.open) console.log('  ' + u + ',<Untitled>,true,Pixel');
} else if (cmd === 'run' && argv[1].endsWith('demo-doc.js')) {
  s.open.push('${DEMO}');
  console.log('{"uuid":"${DEMO}"}');
} else if (cmd === 'render') {
  console.log('render: out.jpg');
} else if (cmd === 'doc' && sub === 'new') {
  s.open.push('${EXTRA}');
  if (process.env.STUB_NEW === 'dirty') s.dirty.push('${EXTRA}');
  console.log('doc: ${EXTRA}');
} else if (cmd === 'doc' && sub === 'save') {
  if (process.env.STUB_SAVE === 'fail') {
    save();
    console.log('error: boom');
    process.exit(1);
  }
  s.dirty = s.dirty.filter((u) => !u.startsWith(argv[2].toUpperCase()));
  console.log('bytes: 12');
} else if (cmd === 'doc' && sub === 'close') {
  if (s.dirty.some((u) => u.startsWith(argv[2].toUpperCase()))) {
    save();
    console.log('error: document ' + argv[2] + ' has unsaved changes');
    process.exit(1);
  }
  s.open = s.open.filter((u) => !u.startsWith(argv[2].toUpperCase()));
  console.log('closed');
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
  return { id: "t", feature: "t", title: "T", summary: "s", commands: ["$BIN doc new --transparent"], output: ["doc: <uuid8>"], images: [], needs: ["affinity"], ...over };
}

function opts(id: string, env: Record<string, string> = {}) {
  return { bin: stubBin, cwd: tmp, outDir: join(tmp, "work", id), demoScript: join(tmp, "demo-doc.js"), env: { STUB_STATE: state, ...env } };
}

const log = (): string[] => JSON.parse(readFileSync(state, "utf8")).log as string[];
const open = (): string[] => JSON.parse(readFileSync(state, "utf8")).open as string[];

beforeEach(() => rmSync(state, { force: true }));

describe("runExample ends the document that doc new makes", () => {
  it("closes a dirty document after saving it to new.af, and records only the example's own command", () => {
    const o = opts("dirty", { STUB_NEW: "dirty" });
    const r = runExample(ex({ id: "dirty" }), o);
    expect(r.ok).toBe(true);
    expect(log().filter((c) => c.startsWith("doc "))).toEqual([
      "doc new --transparent",
      "doc close BBBBBBBB",
      `doc save BBBBBBBB ${join(o.outDir, "new.af")} --force`,
      "doc close BBBBBBBB",
    ]);
    expect(open()).toEqual([]);
    expect(r.output).toBe("$ affinity-axi doc new --transparent\ndoc: " + EXTRA + "\n");
  });

  it("fails the example, names the open document and stops when the save fails", () => {
    const r = runExample(ex({ id: "savefail", commands: ["$BIN doc new --transparent", "$BIN render"] }), opts("savefail", { STUB_NEW: "dirty", STUB_SAVE: "fail" }));
    expect(r.ok).toBe(false);
    expect(r.failed).toMatchObject({ kind: "cleanup", leftOpen: "BBBBBBBB", message: "error: boom" });
    expect(log().filter((c) => c.startsWith("doc close"))).toHaveLength(1);
    expect(log().some((c) => c.startsWith("render"))).toBe(false);
    expect(open()).toEqual([EXTRA]);
  });

  it("ends both the new document and the demo document, saving to new.af and demo.af", () => {
    const o = opts("both", { STUB_NEW: "dirty" });
    const r = runExample(ex({ id: "both", commands: ["$BIN doc new --transparent", "$BIN render $DOC"], needs: ["affinity", "document"] }), o);
    expect(r.ok).toBe(true);
    const calls = log();
    expect(calls).toContain(`doc save BBBBBBBB ${join(o.outDir, "new.af")} --force`);
    expect(calls).toContain(`doc save AAAAAAAA ${join(o.outDir, "demo.af")} --force`);
    expect(calls.filter((c) => c === "doc close BBBBBBBB")).toHaveLength(2);
    expect(calls).toContain("doc close AAAAAAAA");
    expect(open()).toEqual([]);
  });
});
