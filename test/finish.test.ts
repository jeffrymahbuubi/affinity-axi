// src/commands/finish.ts: reportedUuid, discardDoc (throwaway save), requirePreset, checkExportTarget, exportTo.
// Fake MCP server; the doc-save stub writes the file like Affinity would.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkExportTarget, discardDoc, discardPath, exportTo, reportedUuid, requirePreset } from "../src/commands/finish.js";
import { imageSize } from "../src/affinity/export-area.js";
import { UsageError } from "../src/output/errors.js";
import { fakeConnect } from "./fake-mcp/client.js";
import { FIXTURE_PRESETS } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";
import type { AffinityClient } from "../src/mcp/types.js";

const UUID = "12345678-ABCD-4ABC-8ABC-123456789ABC";
const uuidFor = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let server: FakeServer;
let client: AffinityClient;
let root: string;
let desktop: string;
const origUrl = process.env["AFFINITY_MCP_URL"];

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  root = mkdtempSync(join(tmpdir(), "axi-finish-"));
  desktop = join(root, "Desktop");
  mkdirSync(desktop);
  client = await fakeConnect()();
});

afterEach(async () => {
  client.close();
  if (origUrl === undefined) delete process.env["AFFINITY_MCP_URL"];
  else process.env["AFFINITY_MCP_URL"] = origUrl;
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

const scripts = (): string[] => server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"]));
const count = (mark: string): number => scripts().filter((s) => s.includes(mark)).length;
const savedTo = (script: string): string => JSON.parse(/const outPath = (".*");/.exec(script)![1]!) as string;

describe("reportedUuid", () => {
  it("a uuid JSON line wins, else the first UUID, else undefined", () => {
    expect(reportedUuid(`log ${uuidFor(9)}\n{"uuid":"${uuidFor(1)}"}`)).toBe(uuidFor(1).toUpperCase());
    expect(reportedUuid(`made ${uuidFor(2)}`)).toBe(uuidFor(2).toUpperCase());
    expect(reportedUuid("nothing")).toBeUndefined();
    expect(reportedUuid('{"uuid":"nope"}\nplain')).toBeUndefined();
  });
});

describe("discardPath", () => {
  it("uses the first 8 characters, upper-case", () => {
    expect(discardPath(desktop, "abcdef12-0000-4000-8000-000000000000")).toBe(join(desktop, "affinity-axi-discard-ABCDEF12.af"));
  });
});

describe("discardDoc", () => {
  const tmp = (): string => discardPath(desktop, UUID);

  it("a clean document: one close script, no save", async () => {
    server.onScript("affinity-axi:doc-close", JSON.stringify({ status: "closed", uuid: UUID }));
    expect(await discardDoc(client, desktop, UUID)).toEqual({ status: "closed" });
    expect(count("affinity-axi:doc-close")).toBe(1);
    expect(count("affinity-axi:doc-save")).toBe(0);
  });

  it("a dirty document: close, save a throwaway, close, delete the file", async () => {
    let closes = 0;
    server.onScript("affinity-axi:doc-close", () => JSON.stringify({ status: ++closes === 1 ? "dirty" : "closed", uuid: UUID }));
    server.onScript("affinity-axi:doc-save", (s) => {
      writeFileSync(savedTo(s), "af");
      return JSON.stringify({ status: "saved", uuid: UUID, path: savedTo(s), dirty: false });
    });
    expect(await discardDoc(client, desktop, UUID)).toEqual({ status: "discarded" });
    expect(count("affinity-axi:doc-close")).toBe(2);
    const save = scripts().find((s) => s.includes("affinity-axi:doc-save"))!;
    expect(savedTo(save)).toBe(tmp());
    expect(existsSync(tmp())).toBe(false);
  });

  it("a save that leaves the document dirty fails without a second close", async () => {
    server.onScript("affinity-axi:doc-close", JSON.stringify({ status: "dirty", uuid: UUID }));
    server.onScript("affinity-axi:doc-save", (s) => {
      writeFileSync(savedTo(s), "af");
      return JSON.stringify({ status: "saved", uuid: UUID, path: savedTo(s), dirty: true });
    });
    const r = await discardDoc(client, desktop, UUID);
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.message).toContain("could not save a throwaway copy to");
    expect(count("affinity-axi:doc-close")).toBe(1);
  });

  it("a save that writes no file fails", async () => {
    server.onScript("affinity-axi:doc-close", JSON.stringify({ status: "dirty", uuid: UUID }));
    server.onScript("affinity-axi:doc-save", JSON.stringify({ status: "saved", uuid: UUID, path: tmp(), dirty: false }));
    const r = await discardDoc(client, desktop, UUID);
    expect(r).toMatchObject({ status: "failed" });
    expect(count("affinity-axi:doc-close")).toBe(1);
  });

  it("a second close that stays open fails and keeps the throwaway file", async () => {
    let closes = 0;
    server.onScript("affinity-axi:doc-close", () => JSON.stringify({ status: ++closes === 1 ? "dirty" : "still-open", uuid: UUID }));
    server.onScript("affinity-axi:doc-save", (s) => {
      writeFileSync(savedTo(s), "af");
      return JSON.stringify({ status: "saved", uuid: UUID, path: savedTo(s), dirty: false });
    });
    const r = await discardDoc(client, desktop, UUID);
    expect(r).toMatchObject({ status: "failed", leftover: tmp() });
    if (r.status === "failed") expect(r.message).toBe("saved a throwaway copy but the document did not close (still-open); check Affinity for a dialog");
    expect(existsSync(tmp())).toBe(true);
  });

  it("a missing document is missing, on the first close and on the save", async () => {
    server.onScript("affinity-axi:doc-close", JSON.stringify({ status: "missing", uuid: UUID }));
    expect(await discardDoc(client, desktop, UUID)).toEqual({ status: "missing" });
  });

  it("missing on the save reply is missing", async () => {
    server.onScript("affinity-axi:doc-close", JSON.stringify({ status: "dirty", uuid: UUID }));
    server.onScript("affinity-axi:doc-save", JSON.stringify({ status: "missing", uuid: UUID }));
    expect(await discardDoc(client, desktop, UUID)).toEqual({ status: "missing" });
  });

  it("an old throwaway file is replaced", async () => {
    writeFileSync(tmp(), "old");
    let closes = 0;
    server.onScript("affinity-axi:doc-close", () => JSON.stringify({ status: ++closes === 1 ? "dirty" : "closed", uuid: UUID }));
    server.onScript("affinity-axi:doc-save", (s) => {
      expect(existsSync(savedTo(s))).toBe(false); // deleted before the save
      writeFileSync(savedTo(s), "new");
      return JSON.stringify({ status: "saved", uuid: UUID, path: savedTo(s), dirty: false });
    });
    expect(await discardDoc(client, desktop, UUID)).toEqual({ status: "discarded" });
    expect(existsSync(tmp())).toBe(false);
  });

  it("a script error becomes failed", async () => {
    server.onScript("affinity-axi:doc-close", "Error: boom\n    at main:1:1");
    const r = await discardDoc(client, desktop, UUID);
    expect(r.status).toBe("failed");
  });
});

describe("requirePreset", () => {
  it("returns the live presets and names the closest match for an unknown one", async () => {
    server.onScript("affinity-axi:list-presets", JSON.stringify(FIXTURE_PRESETS));
    expect(await requirePreset(client, FIXTURE_PRESETS[0]!)).toEqual(FIXTURE_PRESETS);
    const err = await requirePreset(client, "png").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect((err as UsageError).message).toBe("unknown export preset 'png'");
    expect((err as UsageError).suggestion).toContain("closest: ");
    expect((err as UsageError).suggestion).toContain("affinity-axi presets");
  });
});

describe("checkExportTarget", () => {
  const msg = (fn: () => void): UsageError => {
    try {
      fn();
    } catch (e) {
      return e as UsageError;
    }
    throw new Error("did not throw");
  };

  it("accepts a matching extension, jpg and jpeg alike", () => {
    expect(() => checkExportTarget("PNG", join(root, "a.png"), 100)).not.toThrow();
    expect(() => checkExportTarget("JPEG (high quality)", join(root, "a.jpg"), undefined)).not.toThrow();
    expect(() => checkExportTarget("JPEG (high quality)", join(root, "a.jpeg"), 10)).not.toThrow();
    expect(() => checkExportTarget("PNG", join(root, "a.PNG"), undefined)).not.toThrow();
  });

  it("refuses a hidden path", () => {
    expect(msg(() => checkExportTarget("PNG", join(root, ".hid", "a.png"), undefined)).message).toContain("--out is inside a hidden folder");
  });

  it("refuses a preset with an unknown file type", () => {
    const e = msg(() => checkExportTarget("Mystery", join(root, "a.png"), undefined));
    expect(e.message).toBe("cannot tell the file type of preset 'Mystery'");
    expect(e.suggestion).toBe("run 'affinity-axi presets' and pick a PNG, JPEG, WebP, SVG or PDF preset");
  });

  it("refuses an extension that does not match the preset", () => {
    const e = msg(() => checkExportTarget("PNG", join(root, "a.jpg"), undefined));
    expect(e.message).toContain("--out must end in .png for preset 'PNG': ");
    expect(e.suggestion).toBe("rename the file, or pick the preset that writes that type");
  });

  it("refuses --width for a non-raster type", () => {
    const e = msg(() => checkExportTarget("PDF", join(root, "a.pdf"), 100));
    expect(e.message).toBe("--width needs a PNG, JPEG or WebP export");
    expect(e.suggestion).toBe("drop --width, or use a raster preset");
  });
});

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
/** A PNG as Affinity writes it: an iTXt XMP chunk naming the account. */
function stampedPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const xmp = "XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta>account-handle</x:xmpmeta>";
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("iTXt", Buffer.from(xmp)), chunk("IDAT", Buffer.from([1, 2, 3, 4])), chunk("IEND", Buffer.alloc(0))]);
}

describe("exportTo", () => {
  function stubExport(): void {
    server.onScript("affinity-axi:export", (s) => {
      writeFileSync(JSON.parse(/const outPath = (".*");/.exec(s)![1]!) as string, stampedPng(100, 50));
      return JSON.stringify({ exported: "x" });
    });
    server.onScript("affinity-axi:area-export", (s) => {
      const size = JSON.parse(/const outSize = (.*);/.exec(s)![1]!) as { width: number; height: number };
      writeFileSync(JSON.parse(/const outPath = (".*");/.exec(s)![1]!) as string, stampedPng(size.width, size.height));
      return JSON.stringify({ exported: "x" });
    });
  }

  it("one export script and a stripped file", async () => {
    stubExport();
    const path = join(desktop, "out.png");
    const r = await exportTo(client, UUID, { preset: "PNG", path, timeoutMs: 5000 });
    expect(count("affinity-axi:export")).toBe(1);
    expect(count("affinity-axi:area-export")).toBe(0);
    expect(readFileSync(path).includes("iTXt")).toBe(false);
    expect(r).toMatchObject({ path, size: "100x50", note: "exported out.png", entry: { path, preset: "PNG", size: "100x50" } });
    expect(r.bytes).toBe(readFileSync(path).length);
  });

  it("with width a second area-export carries the computed size", async () => {
    stubExport();
    const path = join(desktop, "out.png");
    const r = await exportTo(client, UUID, { preset: "PNG", path, width: 50, timeoutMs: 5000 });
    expect(count("affinity-axi:export")).toBe(1);
    const second = scripts().filter((s) => s.includes("affinity-axi:area-export"));
    expect(second).toHaveLength(1);
    expect(second[0]).toContain('const outSize = {"width":50,"height":25};');
    expect(imageSize(readFileSync(path))).toEqual({ width: 50, height: 25 });
    expect(readFileSync(path).includes("iTXt")).toBe(false);
    expect(r.note).toBe("exported out.png (50x25)");
    expect(r.size).toBe("50x25");
  });

  it("with a width equal to the natural one there is no second export", async () => {
    stubExport();
    const r = await exportTo(client, UUID, { preset: "PNG", path: join(desktop, "same.png"), width: 100, timeoutMs: 5000 });
    expect(count("affinity-axi:area-export")).toBe(0);
    expect(r.note).toBe("exported same.png (100x50)");
  });
});
