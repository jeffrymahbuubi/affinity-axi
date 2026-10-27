// export --timeout and the temp-and-rename write: the default reaches callTool, a timed-out export never touches the target
// (it removes the temp file and names it), a finished export renames the temp onto the target, bad values are usage errors.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { make as makeExportModule } from "../src/commands/export.js";
import { TransportError } from "../src/mcp/client.js";
import type { ConnectFn } from "../src/mcp/types.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_APP, FIXTURE_DOCS, FIXTURE_PRESETS, FIXTURE_UUID, TINY_JPEG_B64 } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

let server: FakeServer;
let root: string;
let desktop: string;
const origUrl = process.env["AFFINITY_MCP_URL"];

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  root = mkdtempSync(join(tmpdir(), "axi-exto-"));
  desktop = join(root, "Desktop");
  mkdirSync(desktop);
  server.onScript("affinity-axi:list-presets", JSON.stringify(FIXTURE_PRESETS));
  server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
  server.onScript("affinity-axi:list-documents", JSON.stringify({ current: FIXTURE_UUID, documents: FIXTURE_DOCS }));
});

afterEach(async () => {
  if (origUrl === undefined) delete process.env["AFFINITY_MCP_URL"];
  else process.env["AFFINITY_MCP_URL"] = origUrl;
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

const isExport = (script: string): boolean => /affinity-axi:(area-)?export/.test(script);

/**
 * The fake client skips timeouts, so this wraps it: it records the timeoutMs of every export call and,
 * from the `stallFrom`-th export call on (1-based), runs `onStall` and rejects like the real transport does.
 */
function spyConnect(opts: { stallFrom?: number; onStall?: (script: string) => void } = {}): { connect: ConnectFn; seen: Array<number | undefined> } {
  const seen: Array<number | undefined> = [];
  const inner = fakeConnect();
  let exports = 0;
  const connect: ConnectFn = async (o) => {
    const c = await inner(o);
    const orig = c.callTool.bind(c);
    c.callTool = async (name, args, callOpts) => {
      const script = String(args["script"] ?? "");
      if (name === "execute_script" && isExport(script)) {
        exports += 1;
        seen.push(callOpts?.timeoutMs);
        if (opts.stallFrom !== undefined && exports >= opts.stallFrom) {
          opts.onStall?.(script);
          throw new TransportError(`tools/call timed out after ${callOpts?.timeoutMs} ms`);
        }
      }
      return orig(name, args, callOpts);
    };
    return c;
  };
  return { connect, seen };
}

/** The temp path the export script was told to write to. */
const outOf = (script: string): string => JSON.parse(/const outPath = (.*);/.exec(script)![1]!) as string;
/** The page file `<tmpstem>_<k><ext>` Affinity writes next to a temp path on a multi-page document. */
const pageOfTemp = (tmp: string, k: number): string => join(tmp, "..", `${basename(tmp, extname(tmp))}_${k}${extname(tmp)}`);
const names = (dir: string): string[] => readdirSync(dir).sort();

describe("export --timeout", () => {
  it("passes 30000 ms to the export call by default and the flag value when given", async () => {
    const target = join(desktop, "a.png");
    server.onScript("affinity-axi:export", (script) => (writeFileSync(outOf(script), "p".repeat(64)), "{}"));
    const dflt = spyConnect();
    expect((await runCommand(makeExportModule(dflt.connect).export, ["current", "PNG", target, "--no-alt"])).code).toBe(0);
    expect(dflt.seen).toEqual([30000]);
    const custom = spyConnect();
    expect((await runCommand(makeExportModule(custom.connect).export, ["current", "PNG", target, "--no-alt", "--timeout", "45000"])).code).toBe(0);
    expect(custom.seen).toEqual([45000]);
  });

  it("writes to a sibling temp name in the same folder and renames it onto the target, replacing an older file", async () => {
    const target = join(desktop, "swap.png");
    writeFileSync(target, "older");
    const sent: string[] = [];
    server.onScript("affinity-axi:export", (script) => (sent.push(outOf(script)), writeFileSync(outOf(script), "fresh file"), "{}"));
    const r = await runCommand(makeExportModule(fakeConnect()).export, ["current", "PNG", target, "--no-alt"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`export: ${target}`);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/\/swap\.axi-tmp-[0-9a-f]{6}\.png$/);
    expect(readFileSync(target, "utf8")).toBe("fresh file");
    expect(names(desktop)).toEqual(["swap.png"]);
  });

  it("renames every page file to its final name on a multi-page export", async () => {
    const target = join(desktop, "doc.png");
    server.onScript("affinity-axi:export", (script) => ([1, 2].forEach((k) => writeFileSync(pageOfTemp(outOf(script), k), `page ${k}`)), "{}"));
    const r = await runCommand(makeExportModule(fakeConnect()).export, ["current", "PNG", target, "--no-alt"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(join(desktop, "doc_1.png"));
    expect(r.stdout).toContain(join(desktop, "doc_2.png"));
    expect(names(desktop)).toEqual(["doc_1.png", "doc_2.png"]);
  });

  it("leaves a pre-existing target untouched, removes the temp, names it and exits 1 on a timeout", async () => {
    const target = join(desktop, "slow.png");
    writeFileSync(target, "precious");
    let tmp = "";
    const { connect } = spyConnect({ stallFrom: 1, onStall: (script) => ((tmp = outOf(script)), writeFileSync(tmp, "half")) });
    const r = await runCommand(makeExportModule(connect).export, ["current", "PNG", target, "--timeout", "5"]);
    expect(r.code).toBe(1);
    expect(tmp).toMatch(/\/slow\.axi-tmp-[0-9a-f]{6}\.png$/);
    expect(r.stdout).toContain(`timeout: export of ${target} cancelled after 5 ms; Affinity may still write ${tmp} later, delete it when it appears`);
    expect(r.stdout).toContain("heavy live filters stall exports; bake them first (axiBake) or raise --timeout");
    expect(readFileSync(target, "utf8")).toBe("precious");
    expect(existsSync(tmp)).toBe(false);
    expect(names(desktop)).toEqual(["slow.png"]);
  });

  it("creates no file at the target when the stalled call wrote nothing", async () => {
    const target = join(desktop, "none.png");
    const { connect } = spyConnect({ stallFrom: 1 });
    const r = await runCommand(makeExportModule(connect).export, ["current", "PNG", target, "--timeout", "7"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("cancelled after 7 ms");
    expect(names(desktop)).toEqual([]);
  });

  it("removes every temp page file of a whole-document export and leaves the target and other files alone", async () => {
    const target = join(desktop, "doc.png");
    const other = join(desktop, "other_1.png");
    writeFileSync(other, "keep");
    writeFileSync(target, "precious");
    const { connect } = spyConnect({ stallFrom: 1, onStall: (script) => [1, 2].forEach((k) => writeFileSync(pageOfTemp(outOf(script), k), "page")) });
    const r = await runCommand(makeExportModule(connect).export, ["current", "PNG", target, "--timeout", "9"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`timeout: export of ${target} cancelled after 9 ms`);
    expect(names(desktop)).toEqual(["doc.png", "other_1.png"]);
    expect(readFileSync(target, "utf8")).toBe("precious");
  });

  it("aborts the whole --max-kb export when a later attempt times out, using a fresh temp name per attempt", async () => {
    const target = join(desktop, "ad.jpg");
    const big = Buffer.concat([Buffer.from(TINY_JPEG_B64, "base64"), Buffer.alloc(8192)]);
    const sent: string[] = [];
    server.onScript("affinity-axi:export", (script) => (sent.push(outOf(script)), writeFileSync(outOf(script), big), "{}"));
    let stalled = "";
    const { connect, seen } = spyConnect({ stallFrom: 2, onStall: (script) => ((stalled = outOf(script)), writeFileSync(stalled, "half")) });
    const r = await runCommand(makeExportModule(connect).export, ["current", "JPEG (High quality)", target, "--max-kb", "1", "--timeout", "11", "--no-alt"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`timeout: export of ${target} cancelled after 11 ms; Affinity may still write ${stalled} later`);
    expect(seen).toEqual([11, 11]);
    expect(sent[0]).not.toBe(stalled);
    expect(existsSync(stalled)).toBe(false);
    expect(names(desktop)).toEqual(["ad.jpg"]); // the first attempt finished and was renamed; the stalled one left nothing
  });

  it.each(["0", "-5", "soon", "1.5", "1e3", ""])("rejects --timeout '%s' as a usage error before connecting", async (bad) => {
    const target = join(desktop, "x.png");
    const { connect } = spyConnect();
    const r = await runCommand(makeExportModule(connect).export, ["current", "PNG", target, "--timeout", bad]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("invalid --timeout");
    expect(server.sessionsOpened()).toBe(0);
  });
});
