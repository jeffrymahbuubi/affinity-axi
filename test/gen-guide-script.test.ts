// scripts/gen-guide.mjs: --file points the check and the writer at another file,
// and a CRLF copy of the guide counts as current. The test writes the CRLF itself,
// so it behaves the same on every OS. Needs `npm run build` (dist/).

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { renderGuide } from "../src/guide/content.js";

const toolDir = fileURLToPath(new URL("..", import.meta.url));
const script = join(toolDir, "scripts/gen-guide.mjs");
const tmp = mkdtempSync(join(tmpdir(), "axi-genguide-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const lf = renderGuide();
const crlf = lf.replace(/\n/g, "\r\n");
const run = (...args: string[]) => spawnSync("node", [script, ...args], { encoding: "utf8" });
const put = (name: string, text: string): string => {
  const p = join(tmp, name);
  writeFileSync(p, text);
  return p;
};

describe("scripts/gen-guide.mjs --check --file", () => {
  it("passes for an LF copy and for a CRLF copy", () => {
    for (const [name, text] of [["lf.md", lf], ["crlf.md", crlf]] as const) {
      const r = run("--check", "--file", put(name, text));
      expect(r.status, name).toBe(0);
      expect(r.stdout).toContain("up to date");
    }
  });

  it("fails for a CRLF copy with one line changed", () => {
    const lines = crlf.split("\r\n");
    lines[2] = `${lines[2]} changed`;
    const r = run("--check", "--file", put("changed.md", lines.join("\r\n")));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("stale or missing");
  });

  it("fails for a missing file", () => {
    const r = run("--check", "--file", join(tmp, "missing.md"));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("stale or missing");
  });
});

describe("scripts/gen-guide.mjs --file without --check", () => {
  it("leaves a current CRLF copy alone", () => {
    const p = put("noop.md", crlf);
    const r = run("--file", p);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no-op");
    expect(readFileSync(p, "utf8")).toBe(crlf);
  });

  it("writes the LF content over a stale copy", () => {
    const p = put("stale.md", crlf.replace("\r\n", " stale\r\n"));
    const r = run("--file", p);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("wrote");
    expect(readFileSync(p, "utf8")).toBe(lf);
  });

  it("creates a missing file", () => {
    const p = join(tmp, "new.md");
    expect(run("--file", p).status).toBe(0);
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, "utf8")).toBe(lf);
  });
});

describe("scripts/gen-guide.mjs --check without --file", () => {
  it("checks the committed guide, whatever its line endings", () => {
    const r = run("--check");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("up to date");
  });
});
