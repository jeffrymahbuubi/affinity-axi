// `fonts` command, in-process against the fake MCP server.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIST_FONTS, make } from "../src/commands/fonts.js";
import type { ConnectFn } from "../src/mcp/types.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

let server: FakeServer;
let connects: number;

const counting: ConnectFn = (opts) => {
  connects++;
  return fakeConnect()(opts);
};

const mod = () => make(counting);
const fontCalls = () => server.calls.filter((c) => c.name === "execute_script" && String(c.args["script"]).includes("affinity-axi:list-fonts"));

type Row = [string, string, string];
const SAMPLE: Row[] = [
  ["Fraunces", "Fraunces-SemiBold", ""],
  ["Fraunces", "Fraunces-Regular", "Regular"],
  ["Nunito", "Nunito-Bold", "Bold"],
  ["Nunito", "Nunito-Regular", "Regular"],
  ["Plus Jakarta Sans", "PlusJakartaSans-Regular_Bold", ""],
];

function stub(rows: Row[]): void {
  server.onScript("affinity-axi:list-fonts", JSON.stringify(rows));
}

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  connects = 0;
});

afterEach(async () => {
  delete process.env["AFFINITY_MCP_URL"];
  await server.close();
});

describe("fonts script", () => {
  it("starts with the marker, is read-only and logs JSON", () => {
    expect(LIST_FONTS.split("\n")[0]).toBe("/* affinity-axi:list-fonts */");
    expect(LIST_FONTS).toContain("FontFamily.all");
    expect(LIST_FONTS).toContain("console.log(JSON.stringify(");
    expect(LIST_FONTS).not.toMatch(/Document\.|\.export\(|addNode|saveAs|close\(/);
  });
});

describe("fonts listing", () => {
  it("lists rows sorted with the count, a derived style and the apply help line", async () => {
    stub(SAMPLE);
    const r = await runCommand(mod(), []);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("fonts[5]{family,postscript,style}:");
    expect(r.stdout).toContain("  Fraunces,Fraunces-Regular,Regular");
    // empty traitsName falls back to the postscript suffix
    expect(r.stdout).toContain("  Fraunces,Fraunces-SemiBold,SemiBold");
    expect(r.stdout).toContain("  Plus Jakarta Sans,PlusJakartaSans-Regular_Bold,Regular_Bold");
    expect(r.stdout.indexOf("Fraunces-Regular")).toBeLessThan(r.stdout.indexOf("Nunito-Bold"));
    expect(r.stdout).toMatch(/^help\[\d\]:/m);
    expect(r.stdout).toContain("StoryDelta.createFont(FontField.PostscriptName | FontField.FamilyName, font)");
    expect(r.stdout).toContain("postscriptName === 'Fraunces-Regular'");
    expect(fontCalls()).toHaveLength(1);
  });

  it("--grep is case-insensitive and matches family or postscript name", async () => {
    stub(SAMPLE);
    const byFamily = await runCommand(mod(), ["--grep", "NUNITO"]);
    expect(byFamily.stdout).toContain("fonts[2]{family,postscript,style}:");
    const byPs = await runCommand(mod(), ["--grep", "regular_bold"]);
    expect(byPs.stdout).toContain("fonts[1]{family,postscript,style}:");
    expect(byPs.stdout).toContain("PlusJakartaSans-Regular_Bold");
    const alt = await runCommand(mod(), ["--grep", "^(Fraunces-SemiBold|Nunito-Bold)$"]);
    expect(alt.stdout).toContain("fonts[2]{family,postscript,style}:");
  });

  it("--family is an exact (case-insensitive) family match", async () => {
    stub(SAMPLE);
    const r = await runCommand(mod(), ["--family", "nunito"]);
    expect(r.stdout).toContain("fonts[2]{family,postscript,style}:");
    expect(r.stdout).not.toContain("Fraunces");
    const partial = await runCommand(mod(), ["--family", "Nun"]);
    expect(partial.stdout).toContain("fonts: 0 matching family 'Nun' (5 installed)");
  });

  it("deduplicates repeated postscript names", async () => {
    stub([...SAMPLE, ["Nunito", "Nunito-Bold", "Bold"]]);
    const r = await runCommand(mod(), ["--grep", "nunito"]);
    expect(r.stdout).toContain("fonts[2]{family,postscript,style}:");
  });

  it("passes --url through to the connection", async () => {
    stub(SAMPLE);
    delete process.env["AFFINITY_MCP_URL"];
    const r = await runCommand(mod(), ["--url", server.url]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("fonts[5]");
  });
});

describe("fonts empty state", () => {
  it("is definitive and names the installed total", async () => {
    stub(SAMPLE);
    const r = await runCommand(mod(), ["--grep", "zzz"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("fonts: 0 matching 'zzz' (5 installed)");
    expect(r.stdout).toContain("affinity-axi fonts --full");
  });

  it("handles no fonts at all", async () => {
    stub([]);
    const r = await runCommand(mod(), []);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("fonts: 0 installed");
  });
});

describe("fonts truncation", () => {
  const many: Row[] = Array.from({ length: 95 }, (_, i) => ["Big", `Big-W${String(i).padStart(3, "0")}`, ""]);

  it("shows 40 rows with 'N of M total' and an exact --full hint", async () => {
    stub(many);
    const r = await runCommand(mod(), ["--grep", "big", "--family", "Big"]);
    expect(r.stdout).toContain("fonts[40 of 95 total]{family,postscript,style}:");
    expect(r.stdout.split("\n").filter((l) => l.startsWith("  Big,")).length).toBe(40);
    expect(r.stdout).toContain("affinity-axi fonts --grep big --family Big --full");
  });

  it("quotes the regex in the --full hint", async () => {
    stub(many);
    const r = await runCommand(mod(), ["--grep", "big|nope"]);
    expect(r.stdout).toContain("affinity-axi fonts --grep 'big|nope' --full");
  });

  it("--full prints every row and no --full hint", async () => {
    stub(many);
    const r = await runCommand(mod(), ["--full"]);
    expect(r.stdout).toContain("fonts[95]{family,postscript,style}:");
    expect(r.stdout.split("\n").filter((l) => l.startsWith("  Big,")).length).toBe(95);
    expect(r.stdout).not.toContain("--full");
  });

  it("does not truncate at or under the limit", async () => {
    stub(many.slice(0, 40));
    const r = await runCommand(mod(), []);
    expect(r.stdout).toContain("fonts[40]{family,postscript,style}:");
  });
});

describe("fonts failures", () => {
  it("an invalid regex exits 2 before connecting", async () => {
    const r = await runCommand(mod(), ["--grep", "("]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("error: invalid --grep regex '('");
    expect(connects).toBe(0);
    expect(server.sessionsOpened()).toBe(0);
  });

  it("an SDK error becomes a structured error, exit 1", async () => {
    server.onScript("affinity-axi:list-fonts", "ERROR: boom");
    const r = await runCommand(mod(), []);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("error: listing fonts failed");
  });

  it("unreadable output becomes a structured error, exit 1", async () => {
    server.onScript("affinity-axi:list-fonts", "not json");
    const r = await runCommand(mod(), []);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("error: listing fonts returned unreadable output");
  });

  it("--help is declared on the spec and makes no connection", async () => {
    const m = mod();
    expect(m.spec.name).toBe("fonts");
    expect(m.spec.flags.map((f) => f.name).sort()).toEqual(["family", "full", "grep", "url"]);
    const { dispatch } = await import("../src/cli/router.js");
    const code = await dispatch({ tool: "affinity-axi", root: m, rootHelp: () => "", commands: { fonts: m }, aliases: {} }, ["fonts", "--help"]);
    expect(code).toBe(0);
    expect(connects).toBe(0);
  });
});
