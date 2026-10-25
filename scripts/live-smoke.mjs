#!/usr/bin/env node
// Live smoke and stability suite against a running Affinity. Spawns the built
// bin for each step and checks its output. It never calls hint add,
// save_script_to_library or report_sdk_issue. Every document it creates is
// saved under examples/_run/smoke/ inside this tool (git-ignored; the tool lives
// under Desktop, where Affinity can write, and Affinity refuses hidden folders
// such as .affinity-axi/) and closed again, so repeated runs
// leave Affinity as they found it. `--repeat N` runs the suite N times to
// catch flaky behaviour.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.env["AFFINITY_AXI_SMOKE_DIR"] ?? join(toolDir, "examples", "_run", "smoke");
const bin = join(toolDir, "bin/affinity-axi.js");

const repeatArg = process.argv.indexOf("--repeat");
const repeat = repeatArg > 0 ? Number(process.argv[repeatArg + 1]) : 1;
if (!Number.isInteger(repeat) || repeat < 1) {
  process.stdout.write("error: --repeat needs a positive integer\n");
  process.exit(2);
}

function cli(...args) {
  const t0 = Date.now();
  const r = spawnSync("node", [bin, ...args], { cwd: toolDir, encoding: "utf8", timeout: 120_000 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "", ms: Date.now() - t0 };
}

const results = [];
function step(round, name, fn) {
  let ok = false;
  let note = "";
  const t0 = Date.now();
  try {
    const res = fn();
    ok = res === true || (typeof res === "string" && res.length > 0);
    note = typeof res === "string" ? res : "";
  } catch (e) {
    note = String(e?.message ?? e);
  }
  results.push({ round, name, ok, note: note.replace(/,/g, ";"), ms: Date.now() - t0 });
  return ok;
}

function withTempScript(body, fn) {
  const dir = mkdtempSync(join(tmpdir(), "affinity-axi-smoke-"));
  const file = join(dir, "s.js");
  writeFileSync(file, body);
  try {
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Saves then closes a document; the only cleanup path that cannot prompt. */
function saveAndClose(uuid, name) {
  const s = cli("doc", "save", uuid, join(outDir, `${name}.af`));
  if (s.code !== 0) return false;
  return cli("doc", "close", uuid).code === 0;
}

function suite(round) {
  const S = (name, fn) => step(round, name, fn);
  let smokeDoc = "";
  let demoDoc = "";

  S("home", () => cli().out.includes("affinity: connected"));

  S("run smoke-doc.js", () => {
    const r = cli("run", join(toolDir, "test/live/smoke-doc.js"));
    smokeDoc = /session ([0-9A-F-]{36})/.exec(r.out)?.[1] ?? "";
    return r.code === 0 && r.out.includes("status: ok") && smokeDoc !== "" ? smokeDoc.slice(0, 8) : false;
  });

  S("render", () => {
    const r = cli("render", smokeDoc || "current");
    return r.code === 0 && /size: \d+x\d+/.test(r.out) ? (/size: (\S+)/.exec(r.out)?.[1] ?? "") : false;
  });

  S("presets", () => {
    const r = cli("presets");
    return r.code === 0 && /^\s+PNG$/m.test(r.out);
  });

  S("export PNG", () => {
    const r = cli("export", smokeDoc || "current", "PNG", join(outDir, "live-export.png"));
    return r.code === 0 ? (/bytes: (\d+)/.exec(r.out)?.[1] ?? "") + " bytes" : false;
  });

  S("docs read preamble --grep", () => {
    const r = cli("docs", "read", "preamble", "--grep", "NOT_ALLOWED");
    return r.code === 0 && /L\d+: /.test(r.out);
  });

  S("library list", () => cli("library").code === 0);

  S("fonts --grep fraunces", () => {
    const r = cli("fonts", "--grep", "fraunces");
    return r.code === 0 && r.out.includes("Fraunces-SemiBold");
  });

  S("doc close refuses unsaved smoke doc", () => {
    const r = cli("doc", "close", smokeDoc);
    return r.code === 1 && r.out.includes("unsaved changes");
  });

  S("doc save + close smoke doc", () => saveAndClose(smokeDoc, "smoke-doc"));

  for (const units of ["px", "mm", "pt"]) {
    S(`doc new --units ${units} + close`, () => {
      const r = cli("doc", "new", "--width", "800", "--height", "600", "--units", units);
      const uuid = /doc: ([0-9A-F-]{36})/.exec(r.out)?.[1];
      if (r.code !== 0 || !uuid) return false;
      // A fresh document is clean, so it closes without a prompt.
      return cli("doc", "close", uuid).code === 0 ? uuid.slice(0, 8) : false;
    });
  }

  S("run --with-helpers demo", () => {
    const r = cli("run", join(toolDir, "test/live/helpers-demo.js"), "--with-helpers");
    demoDoc = /"uuid":"([0-9A-F-]{36})"/.exec(r.out)?.[1] ?? "";
    return r.code === 0 && demoDoc !== "" ? demoDoc.slice(0, 8) : false;
  });

  S("render helpers demo", () => cli("render", demoDoc).code === 0);

  S("doc save + close helpers demo", () => saveAndClose(demoDoc, "helpers-demo"));

  S("AI guard refuses before connecting", () =>
    withTempScript("const d = Document.current;\nd.generateImage('x');\n", (file) => {
      const r = cli("run", file);
      return r.code === 1 && r.out.includes("generateImage at line 2");
    }),
  );

  S("blocking guard refuses close()", () =>
    withTempScript("const d = Document.current;\nd.close();\n", (file) => {
      const r = cli("run", file);
      return r.code === 1 && r.out.includes("close() at line 2");
    }),
  );

  S("no documents left behind", () => {
    const r = cli();
    const left = [smokeDoc, demoDoc].filter((u) => u && r.out.includes(u));
    return left.length === 0 ? true : `left open: ${left.map((u) => u.slice(0, 8)).join(" ")}`;
  });
}

for (let i = 1; i <= repeat; i++) suite(i);

const failed = results.filter((r) => !r.ok);
const rows = repeat === 1 ? results : failed;
process.stdout.write(`smoke[${rows.length}]{round,step,status,ms,note}:\n`);
for (const r of rows) process.stdout.write(`  ${r.round},${r.name},${r.ok ? "pass" : "FAIL"},${r.ms},${r.note}\n`);
if (repeat > 1 && failed.length === 0) process.stdout.write("  (all steps passed in every round)\n");
const slowest = [...results].sort((a, b) => b.ms - a.ms)[0];
process.stdout.write(`summary: ${results.length - failed.length} pass, ${failed.length} fail over ${repeat} round(s)\n`);
if (slowest) process.stdout.write(`slowest: ${slowest.name} ${slowest.ms} ms\n`);
process.exit(failed.length === 0 ? 0 : 1);
