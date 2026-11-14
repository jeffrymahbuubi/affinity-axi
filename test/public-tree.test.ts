// The tool tree must stay free of vendor names, model names and personal
// paths, so it can be published as a standalone repository. This test scans
// every text file for those terms. Every term is spelled in pieces so this
// file passes its own scan. One exception exists at token level: an exact
// Affinity SDK identifier that contains a term (see ALLOWED_TOKENS).

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const toolDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const TERMS = [
  ["cla", "ude"],
  ["anthr", "opic"],
  ["l", "lm"],
  ["g", "pt"],
  ["open", "ai"],
  ["o", "pus"],
  ["son", "net"],
  ["hai", "ku"],
  ["fa", "ble"],
  ["ru", "flo"],
  ["co-auth", "ored"],
  ["ko", "st"],
  ["pulo", "sari"],
  ["/Us", "ers/"],
].map((parts) => parts.join(""));

/**
 * A POSIX home path is a real local path unless its user name is a
 * placeholder. Same rule as the release audit (scripts/audit_release.py,
 * PLACEHOLDERS): trailing digits are ignored, so a numbered placeholder passes.
 */
const HOME_PATH = /\/home\/([A-Za-z0-9._-]+)/gi;
const HOME_PLACEHOLDERS = new Set(["someone", "user", "username", "you", "me", "example", "name", "runner",
  "public", "shared", "default", "x", "foo", "test"]);

/**
 * The only tolerated lines. Affinity's own hint text, captured in the
 * hint-search example and copied into the dashboard, contains a generic
 * placeholder path; the line is allowed only when it carries exactly that
 * placeholder, wherever the copy lives.
 */
const ALLOWED_LINES: Array<{ term: string; contains: string }> = [
  { term: ["/Us", "ers/"].join(""), contains: ["`/Us", "ers/username/Desktop/file.png`"].join("") },
];

/**
 * Affinity's own SDK identifiers that happen to contain a term. The exact,
 * case-sensitive token is blanked before the scan; the term stays forbidden in
 * the rest of the line and in any other word.
 */
const ALLOWED_TOKENS: Array<{ term: string; token: string }> = [
  { term: ["l", "lm"].join(""), token: ["Fil", "lMesh"].join("") },
];

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".astro", "_run", ".affinity-axi", "coverage"]);
const SKIP_FILES = new Set(["package-lock.json"]);
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|af|afdesign|zip)$/i;

interface Hit {
  file: string;
  line: number;
  term: string;
}

/** Terms found in a text, minus the explicitly allowed lines. */
export function scanText(file: string, text: string): Hit[] {
  const hits: Hit[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const term of TERMS) {
      let probe = line;
      for (const a of ALLOWED_TOKENS) if (a.term === term) probe = probe.split(a.token).join(" ");
      if (!probe.toLowerCase().includes(term.toLowerCase())) continue;
      if (ALLOWED_LINES.some((a) => a.term === term && line.includes(a.contains))) continue;
      hits.push({ file, line: i + 1, term });
    }
    for (const m of line.matchAll(HOME_PATH)) {
      if (HOME_PLACEHOLDERS.has(m[1]!.toLowerCase().replace(/\d+$/, ""))) continue;
      hits.push({ file, line: i + 1, term: m[0] });
    }
  });
  return hits;
}

function textFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) textFiles(p, out);
    } else if (!SKIP_FILES.has(name) && !BINARY.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * The files that get published: git-tracked files when this is a git checkout
 * (ignored local output such as asset manifests and built pages is never
 * published), otherwise every text file on disk.
 */
function publishedFiles(): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], { cwd: toolDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out
      .split("\0")
      .filter((f) => f !== "" && !BINARY.test(f) && !SKIP_FILES.has(f.split("/").pop()!))
      .map((f) => join(toolDir, f))
      .filter((p) => existsSync(p));
  } catch {
    return textFiles(toolDir);
  }
}

describe("public tree", () => {
  it("contains none of the forbidden terms outside the explicit allow-list", () => {
    const hits: Hit[] = [];
    for (const p of publishedFiles()) hits.push(...scanText(relative(toolDir, p), readFileSync(p, "utf8")));
    const report = hits.map((h) => `${h.file}:${h.line} (${h.term})`);
    expect(report).toEqual([]);
  });

  it("flags a planted term, so the scan is not vacuous", () => {
    const planted = `// written by ${TERMS[0]}\nplain line\n`;
    expect(scanText("x.ts", planted)).toEqual([{ file: "x.ts", line: 1, term: TERMS[0] }]);
    expect(scanText("x.ts", `see ${TERMS[TERMS.length - 1]}someone/file.png`)).toHaveLength(1);
  });

  it("allows only the generic placeholder path, and generic words stay legal", () => {
    const placeholder = `e.g., ${ALLOWED_LINES[0]!.contains}`;
    expect(scanText("hint.txt", placeholder)).toEqual([]);
    expect(scanText("hint.txt", `${TERMS[TERMS.length - 1]}real/Desktop/file.png`)).toHaveLength(1);
    expect(scanText("a.md", "Canva AI Studio features, and any coding agent")).toEqual([]);
  });

  it("allows the exact SDK identifier token only, the term stays banned elsewhere", () => {
    const t = ALLOWED_TOKENS[0]!.term;
    const T = ALLOWED_TOKENS[0]!.token;
    // positive: the SDK topic names
    expect(scanText("o.txt", `  ts/dom/${T}SubSelectionApi.d.ts`)).toEqual([]);
    expect(scanText("o.txt", `  ts/dom/Line${T}SubSelectionApi.d.ts`)).toEqual([]);
    // negative: another word containing the term
    expect(scanText("o.txt", `  ${["fil", "lmeta"].join("")}`)).toEqual([{ file: "o.txt", line: 1, term: t }]);
    // negative: other casing of the identifier
    expect(scanText("o.txt", T.toLowerCase())).toHaveLength(1);
    expect(scanText("o.txt", T.toUpperCase())).toHaveLength(1);
    // same line: a bare use still fails, the token twice does not
    expect(scanText("o.txt", `${T}Api and an ${t} note`)).toHaveLength(1);
    expect(scanText("o.txt", `${T} ${T}`)).toEqual([]);
    // bare term, any case
    expect(scanText("o.txt", `uses an ${t.toUpperCase()}`)).toHaveLength(1);
  });

  it("flags a POSIX home path with a real user name, not a placeholder one", () => {
    const home = ["/ho", "me/"].join("");
    expect(scanText("a.ts", `cwd ${home}jdoe/work`)).toEqual([{ file: "a.ts", line: 1, term: `${home}jdoe` }]);
    expect(scanText("a.ts", `cwd ${home}xy/b`)).toHaveLength(1);
    expect(scanText("a.ts", `cwd ${home}x/Desktop and ${home}someone2/x and ${home}Test/y`)).toEqual([]);
  });

  it("ships LICENSE and CONTRIBUTING.md", () => {
    expect(existsSync(join(toolDir, "LICENSE"))).toBe(true);
    expect(existsSync(join(toolDir, "CONTRIBUTING.md"))).toBe(true);
    const second = readFileSync(join(toolDir, "LICENSE"), "utf8").split(/\r?\n/)[1] ?? "";
    expect(second.startsWith("Copyright (c)")).toBe(true);
  });

  it("no longer ships a skills folder or the token measuring script", () => {
    expect(existsSync(join(toolDir, "skills"))).toBe(false);
    expect(existsSync(join(toolDir, "scripts", "measure-tokens.mjs"))).toBe(false);
    expect(existsSync(join(toolDir, "docs", "agent-guide.md"))).toBe(true);
  });
});
