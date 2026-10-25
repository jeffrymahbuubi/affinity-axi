// Export metadata core (src/affinity/metadata.ts): PNG text-chunk and JPEG segment strip, TIFF via exiftool, hasXmp, notes, credit resolution.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Parsed } from "../src/cli/args.js";
import { creditFor, finalizeFile, hasXmp, metadataNote, stripJpegSegments, stripPngText, type MetaOutcome } from "../src/affinity/metadata.js";
import { UsageError } from "../src/output/errors.js";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const ihdr = (): Buffer => {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(100, 0);
  d.writeUInt32BE(50, 4);
  d[8] = 8;
  d[9] = 6;
  return chunk("IHDR", d);
};
const XMP = chunk("iTXt", Buffer.from("XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta><dc:creator>someone</dc:creator></x:xmpmeta>"));
const COMMENT = chunk("tEXt", Buffer.from("Comment\0hello"));
const ICC = chunk("iCCP", Buffer.from("sRGB\0\0abcdef"));
const PHYS = chunk("pHYs", Buffer.from([0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1]));
const IDAT = chunk("IDAT", Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
const IEND = chunk("IEND", Buffer.alloc(0));
const stamped = (): Buffer => Buffer.concat([SIG, ihdr(), ICC, PHYS, XMP, COMMENT, IDAT, IEND]);
const clean = (): Buffer => Buffer.concat([SIG, ihdr(), ICC, PHYS, IDAT, IEND]);

const flags = (f: Record<string, string | boolean>): Parsed => ({ positionals: [], flags: f, help: false });
const out = (o: Partial<MetaOutcome>): MetaOutcome => ({ kind: "png", stripped: "none", embedded: [], skipped: [], ...o });

describe("stripPngText", () => {
  it("removes exactly the text chunks and copies the rest byte for byte", () => {
    const r = stripPngText(stamped())!;
    expect(r.removed).toBe(2);
    expect(r.buf.equals(clean())).toBe(true);
    expect(r.buf.includes("iCCP")).toBe(true);
    expect(r.buf.includes("pHYs")).toBe(true);
    expect(r.buf.includes("IDAT")).toBe(true);
    expect(r.buf.includes("iTXt")).toBe(false);
    expect(r.buf.includes("tEXt")).toBe(false);
  });

  it("also drops zTXt", () => {
    const r = stripPngText(Buffer.concat([SIG, ihdr(), chunk("zTXt", Buffer.from("k\0\0xx")), IDAT, IEND]))!;
    expect(r.removed).toBe(1);
    expect(r.buf.equals(Buffer.concat([SIG, ihdr(), IDAT, IEND]))).toBe(true);
  });

  it("is idempotent", () => {
    const once = stripPngText(stamped())!;
    const twice = stripPngText(once.buf)!;
    expect(twice.removed).toBe(0);
    expect(twice.buf.equals(once.buf)).toBe(true);
  });

  it("returns null for a truncated or non-PNG buffer", () => {
    const full = stamped();
    expect(stripPngText(full.subarray(0, full.length - 20))).toBeNull(); // IDAT cut short
    expect(stripPngText(full.subarray(0, 8 + 14))).toBeNull(); // partial chunk header
    expect(stripPngText(Buffer.from("not a png at all"))).toBeNull();
    const lie = Buffer.concat([SIG, ihdr(), Buffer.from([0x7f, 0xff, 0xff, 0xff, 0x49, 0x44, 0x41, 0x54, 0, 0, 0, 0])]);
    expect(stripPngText(lie)).toBeNull(); // length past the end
  });

  it("accepts a file that ends on a chunk boundary without IEND, and keeps bytes after IEND", () => {
    const noEnd = Buffer.concat([SIG, ihdr()]);
    expect(stripPngText(noEnd)!.removed).toBe(0);
    const trailing = Buffer.concat([clean(), Buffer.from("tail")]);
    expect(stripPngText(trailing)!.buf.equals(trailing)).toBe(true);
  });

  it("returns null for JPEG and WebP bytes", () => {
    expect(stripPngText(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(stripPngText(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(20)]))).toBeNull();
  });
});

describe("hasXmp", () => {
  it("finds an XMP packet by either marker", () => {
    expect(hasXmp(Buffer.from("....<x:xmpmeta xmlns:x=...."))).toBe(true);
    expect(hasXmp(Buffer.from("Exif\0\0http://ns.adobe.com/xap/1.0/\0<?xpacket"))).toBe(true);
  });
  it("is false for a clean PNG and a bare JPEG", () => {
    expect(hasXmp(clean())).toBe(false);
    expect(hasXmp(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]))).toBe(false);
  });
});

describe("metadataNote", () => {
  it("is null when nothing was asked and the strip worked or was a no-op", () => {
    expect(metadataNote([])).toBeNull();
    expect(metadataNote([out({ stripped: "chunks" }), out({ stripped: "none" }), out({ kind: null })])).toBeNull();
  });
  it("AI only", () => {
    expect(metadataNote([out({ embedded: ["iptc"] })])).toBe("iptc embedded");
    expect(metadataNote([out({ skipped: ["iptc"], error: "exiftool not found" })])).toBe("sidecar only (exiftool not found)");
    expect(metadataNote([out({ skipped: ["iptc"], error: "Error: bad file" })])).toBe("sidecar only (exiftool failed: Error: bad file)");
    expect(metadataNote([out({ kind: null, skipped: ["iptc"], error: "format not supported for embedding" })])).toBe("sidecar only (format not supported for embedding)");
    expect(metadataNote([out({ embedded: ["iptc"] }), out({ skipped: ["iptc"], error: "x" }), out({ embedded: ["iptc"] })])).toBe(
      "iptc embedded in 2 of 3 files, others sidecar only",
    );
  });
  it("credit", () => {
    expect(metadataNote([out({ embedded: ["creator"] })])).toBe("creator embedded");
    expect(metadataNote([out({ embedded: ["creator", "copyright"] })])).toBe("creator and copyright embedded");
    expect(metadataNote([out({ skipped: ["creator"], error: "exiftool not found" })])).toBe("creator NOT embedded (exiftool not found)");
    expect(metadataNote([out({ skipped: ["creator", "copyright"], error: "Bad tag" })])).toBe("creator NOT embedded (exiftool failed: Bad tag)");
  });
  it("combines in order: AI, credit, keep", () => {
    expect(metadataNote([out({ embedded: ["iptc", "creator"] })])).toBe("iptc embedded, creator embedded");
    expect(metadataNote([out({ stripped: "kept", embedded: ["iptc"] })])).toBe("iptc embedded, Affinity XMP kept");
  });
  it("keep and strip problems", () => {
    expect(metadataNote([out({ stripped: "kept" })])).toBe("Affinity XMP kept");
    expect(metadataNote([out({ error: "not a well-formed PNG" })])).toBe("strip skipped (not a well-formed PNG)");
    expect(metadataNote([out({ kind: "jpeg", error: "exiftool not found" })])).toBe("XMP not stripped (exiftool not found)");
  });
});

describe("creditFor", () => {
  const kit = { credit: { creator: "Kit Studio", copyright: "(c) Kit" } } as never;
  it("is undefined without flags or a kit credit", () => {
    expect(creditFor(flags({}), undefined)).toBeUndefined();
    expect(creditFor(flags({}), { name: "x" } as never)).toBeUndefined();
  });
  it("takes the kit credit when no flag is given", () => {
    expect(creditFor(flags({}), kit)).toEqual({ creator: "Kit Studio", copyright: "(c) Kit" });
  });
  it("flags win over the kit", () => {
    expect(creditFor(flags({ creator: "Me" }), kit)).toEqual({ creator: "Me" });
    expect(creditFor(flags({ creator: "Me", copyright: "(c) Me" }), kit)).toEqual({ creator: "Me", copyright: "(c) Me" });
    expect(creditFor(flags({ copyright: "(c) Flag" }), kit)).toEqual({ creator: "Kit Studio", copyright: "(c) Flag" });
    expect(creditFor(flags({ creator: "Me" }), undefined)).toEqual({ creator: "Me" });
  });
  it("an empty --creator means no credit, even with a kit", () => {
    expect(creditFor(flags({ creator: "" }), kit)).toBeUndefined();
  });
  it("--copyright without any creator is a usage error", () => {
    expect(() => creditFor(flags({ copyright: "(c)" }), undefined)).toThrow(UsageError);
    expect(() => creditFor(flags({ copyright: "(c)", creator: "" }), kit)).toThrow(/--copyright needs --creator/);
  });
});

describe("finalizeFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "axi-fin-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("leaves a non-raster file alone", () => {
    const f = join(dir, "a.svg");
    writeFileSync(f, "<svg><metadata>dc:creator</metadata></svg>");
    const o = finalizeFile(f, {});
    expect(o).toEqual({ kind: null, stripped: "none", embedded: [], skipped: [] });
    expect(readFileSync(f, "utf8")).toContain("dc:creator");
  });

  it("reports a non-raster file as skipped when a credit was asked", () => {
    const f = join(dir, "a.pdf");
    writeFileSync(f, "%PDF-1.4");
    const o = finalizeFile(f, { credit: { creator: "X" } });
    expect(o.kind).toBeNull();
    expect(o.skipped).toEqual(["creator"]);
    expect(o.error).toBe("format not supported for embedding");
  });

  it("strips a PNG in place without exiftool", () => {
    const f = join(dir, "a.png");
    writeFileSync(f, stamped());
    const o = finalizeFile(f, {});
    expect(o).toEqual({ kind: "png", stripped: "chunks", embedded: [], skipped: [] });
    expect(readFileSync(f).equals(clean())).toBe(true);
    expect(finalizeFile(f, {}).stripped).toBe("none");
  });

  it("keep leaves the PNG untouched", () => {
    const f = join(dir, "k.png");
    writeFileSync(f, stamped());
    expect(finalizeFile(f, { keep: true }).stripped).toBe("kept");
    expect(readFileSync(f).equals(stamped())).toBe(true);
  });

  it("leaves a malformed PNG untouched and says so", () => {
    const f = join(dir, "bad.png");
    const bad = stamped().subarray(0, 60);
    writeFileSync(f, bad);
    const o = finalizeFile(f, {});
    expect(o.error).toBe("not a well-formed PNG");
    expect(readFileSync(f).equals(bad)).toBe(true);
  });

  it("does not spawn exiftool for a clean JPEG", () => {
    const f = join(dir, "j.jpg");
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
    writeFileSync(f, jpg);
    expect(finalizeFile(f, {})).toEqual({ kind: "jpeg", stripped: "none", embedded: [], skipped: [] });
    expect(readFileSync(f).equals(jpg)).toBe(true);
  });
});

/** One JPEG segment: 0xFF, marker, 2-byte length (counts itself), payload. */
const seg = (marker: number, payload: string | Buffer): Buffer => {
  const body = typeof payload === "string" ? Buffer.from(payload, "latin1") : payload;
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
};
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const JFIF = seg(0xe0, "JFIF\0\x01\x01\0\0\x01\0\x01\0\0");
const ICC_SEG = seg(0xe2, "ICC_PROFILE\0profile");
const DQT = seg(0xdb, Buffer.alloc(65, 3));
const SCAN = Buffer.from([0xff, 0xda, 0, 4, 1, 0, 0x11, 0x22, 0xff, 0xe1, 0x33, 0xff, 0x00, 0x44]); // entropy data holds a 0xFFE1 pair
const EXIF_SEG = seg(0xe1, "Exif\0\0IIaccount-handle");
const XMP_SEG = seg(0xe1, "http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><dc:creator>account-handle</dc:creator></x:xmpmeta>");
const XMPEXT_SEG = seg(0xe1, "http://ns.adobe.com/xmp/extension/\0rest");
const PS_SEG = seg(0xed, "Photoshop 3.0\x008BIM\x04\x04account-handle");
const COM_SEG = seg(0xfe, "note");
const stampedJpeg = (): Buffer => Buffer.concat([SOI, JFIF, EXIF_SEG, XMP_SEG, PS_SEG, COM_SEG, ICC_SEG, DQT, SCAN, EOI]);
const cleanJpeg = (): Buffer => Buffer.concat([SOI, JFIF, ICC_SEG, DQT, SCAN, EOI]);

describe("stripJpegSegments", () => {
  it("drops Exif, XMP, Photoshop and COM and copies the rest byte for byte", () => {
    const r = stripJpegSegments(stampedJpeg())!;
    expect(r.removed).toBe(4);
    expect(r.buf.equals(cleanJpeg())).toBe(true);
    expect(r.buf.includes("ICC_PROFILE")).toBe(true);
    expect(r.buf.includes("JFIF")).toBe(true);
    expect(r.buf.includes("account-handle")).toBe(false);
  });

  it("drops the XMP extension segment too", () => {
    const r = stripJpegSegments(Buffer.concat([SOI, JFIF, XMPEXT_SEG, DQT, SCAN, EOI]))!;
    expect(r.removed).toBe(1);
    expect(r.buf.equals(Buffer.concat([SOI, JFIF, DQT, SCAN, EOI]))).toBe(true);
  });

  it("is idempotent and passes a clean JPEG through as the same buffer", () => {
    const once = stripJpegSegments(stampedJpeg())!;
    const twice = stripJpegSegments(once.buf)!;
    expect(twice.removed).toBe(0);
    expect(twice.buf).toBe(once.buf);
    const clean = cleanJpeg();
    const r = stripJpegSegments(clean)!;
    expect(r.removed).toBe(0);
    expect(r.buf).toBe(clean);
  });

  it("keeps an APP1 with an unknown header and an APP14 Adobe segment", () => {
    const foo = seg(0xe1, "Foo\0bar");
    const adobe = seg(0xee, "Adobe\0\x64\0\0\0\0\x01");
    const src = Buffer.concat([SOI, JFIF, foo, adobe, EXIF_SEG, DQT, SCAN, EOI]);
    const r = stripJpegSegments(src)!;
    expect(r.removed).toBe(1);
    expect(r.buf.equals(Buffer.concat([SOI, JFIF, foo, adobe, DQT, SCAN, EOI]))).toBe(true);
  });

  it("copies everything after SOS verbatim, even 0xFFE1 byte pairs", () => {
    const r = stripJpegSegments(stampedJpeg())!;
    expect(r.buf.subarray(r.buf.length - SCAN.length - 2).equals(Buffer.concat([SCAN, EOI]))).toBe(true);
  });

  it("skips padding 0xFF bytes and standalone markers", () => {
    const src = Buffer.concat([SOI, Buffer.from([0xff, 0xff]), JFIF, Buffer.from([0xff, 0x01]), EXIF_SEG, SCAN, EOI]);
    const r = stripJpegSegments(src)!;
    expect(r.removed).toBe(1);
    expect(r.buf.equals(Buffer.concat([SOI, Buffer.from([0xff, 0xff]), JFIF, Buffer.from([0xff, 0x01]), SCAN, EOI]))).toBe(true);
  });

  it("returns null for a length past the end, a missing marker byte, and non-JPEG bytes", () => {
    const full = stampedJpeg();
    expect(stripJpegSegments(full.subarray(0, 40))).toBeNull(); // cut inside a segment
    expect(stripJpegSegments(Buffer.concat([SOI, JFIF, Buffer.from([0x12, 0x34, 0x56])]))).toBeNull(); // no 0xFF where a marker is due
    expect(stripJpegSegments(Buffer.concat([SOI, JFIF, Buffer.from([0xff])]))).toBeNull(); // marker byte missing
    expect(stripJpegSegments(Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0, 1])]))).toBeNull(); // length below 2
    expect(stripJpegSegments(stamped())).toBeNull();
    expect(stripJpegSegments(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(20)]))).toBeNull();
  });
});

describe("finalizeFile: JPEG and TIFF", () => {
  const origPath = process.env["PATH"];
  let dir: string;
  let log: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "axi-fin-"));
    log = join(dir, "calls.log");
  });
  afterEach(() => {
    if (origPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = origPath;
    rmSync(dir, { recursive: true, force: true });
  });

  /** PATH with a fake exiftool that logs its arguments (exit 0), or without any exiftool. */
  function pathWith(fake: boolean): void {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    if (fake) {
      const file = join(bin, "exiftool");
      writeFileSync(file, `#!/bin/sh\nif [ "$1" = "-ver" ]; then echo 13.55; exit 0; fi\nprintf '%s\\n' "$@" >> "${log}"\necho "--" >> "${log}"\nexit 0\n`);
      chmodSync(file, 0o755);
    }
    process.env["PATH"] = `${bin}:/usr/bin:/bin`;
  }
  const calls = (): string[][] =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("--\n")
          .filter((c) => c !== "")
          .map((c) => c.split("\n").filter((l) => l !== ""))
      : [];
  const put = (name: string, data: Buffer): string => {
    const f = join(dir, name);
    writeFileSync(f, data);
    return f;
  };

  it("strips a stamped JPEG in pure Node, without exiftool", () => {
    pathWith(false);
    const f = put("s.jpg", stampedJpeg());
    expect(finalizeFile(f, {})).toEqual({ kind: "jpeg", stripped: "segments", embedded: [], skipped: [] });
    expect(readFileSync(f).equals(cleanJpeg())).toBe(true);
    expect(finalizeFile(f, {}).stripped).toBe("none");
  });

  it("makes no exiftool call for a stamped JPEG without a credit", () => {
    pathWith(true);
    finalizeFile(put("s.jpg", stampedJpeg()), {});
    expect(calls()).toEqual([]);
  });

  it("a credit adds one exiftool call that clears XMP first and names no EXIF or IPTC tag", () => {
    pathWith(true);
    const f = put("c.jpg", stampedJpeg());
    const o = finalizeFile(f, { credit: { creator: "Studio X" } });
    expect(o).toEqual({ kind: "jpeg", stripped: "segments", embedded: ["creator"], skipped: [] });
    expect(readFileSync(f).equals(cleanJpeg())).toBe(true);
    const c = calls();
    expect(c).toHaveLength(1);
    expect(c[0]).toContain("-overwrite_original");
    expect(c[0]!.indexOf("-XMP:all=")).toBeGreaterThan(-1);
    expect(c[0]!.indexOf("-XMP:all=")).toBeLessThan(c[0]!.indexOf("-XMP-dc:Creator=Studio X"));
    expect(c[0]!.some((a) => a.startsWith("-EXIF:") || a.startsWith("-IPTC:"))).toBe(false);
  });

  it("a credit without exiftool still strips and says only that the credit was not embedded", () => {
    pathWith(false);
    const f = put("n.jpg", stampedJpeg());
    const o = finalizeFile(f, { credit: { creator: "Studio X" } });
    expect(readFileSync(f).equals(cleanJpeg())).toBe(true);
    expect(o.stripped).toBe("segments");
    expect(o.skipped).toEqual(["creator"]);
    expect(o.error).toBe("exiftool not found");
    expect(metadataNote([o])).toBe("creator NOT embedded (exiftool not found)");
  });

  it("keep leaves a stamped JPEG untouched", () => {
    pathWith(false);
    const f = put("k.jpg", stampedJpeg());
    expect(finalizeFile(f, { keep: true }).stripped).toBe("kept");
    expect(readFileSync(f).equals(stampedJpeg())).toBe(true);
  });

  it("leaves a truncated JPEG untouched and says so", () => {
    pathWith(false);
    const bad = stampedJpeg().subarray(0, 40);
    const f = put("bad.jpg", bad);
    const o = finalizeFile(f, {});
    expect(o.error).toBe("not a well-formed JPEG");
    expect(readFileSync(f).equals(bad)).toBe(true);
    expect(metadataNote([o])).toBe("strip skipped (not a well-formed JPEG)");
  });

  const tiff = (): Buffer => Buffer.concat([Buffer.from("II*\0"), Buffer.from([8, 0, 0, 0]), Buffer.alloc(20)]);

  it("routes a TIFF through exiftool: EXIF and IPTC identity tags deleted, XMP cleared, no -all=", () => {
    pathWith(true);
    const f = put("t.tif", tiff());
    const o = finalizeFile(f, {});
    expect(o).toEqual({ kind: "tiff", stripped: "exiftool", embedded: [], skipped: [] });
    const c = calls();
    expect(c).toHaveLength(1);
    for (const a of ["-EXIF:Artist=", "-EXIF:Copyright=", "-IPTC:By-line=", "-IPTC:CopyrightNotice=", "-XMP:all="]) expect(c[0]).toContain(a);
    expect(c[0]!.some((a) => a === "-all=")).toBe(false);
  });

  it("recognises a big-endian TIFF and adds the credit in the same call", () => {
    pathWith(true);
    const f = put("b.tiff", Buffer.concat([Buffer.from("MM\0*"), Buffer.from([0, 0, 0, 8]), Buffer.alloc(20)]));
    const o = finalizeFile(f, { credit: { creator: "Studio X" } });
    expect(o.kind).toBe("tiff");
    expect(o.embedded).toEqual(["creator"]);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toContain("-XMP-dc:Creator=Studio X");
  });

  it("leaves a TIFF untouched without exiftool and reports it", () => {
    pathWith(false);
    const f = put("t.tif", tiff());
    const o = finalizeFile(f, {});
    expect(o).toEqual({ kind: "tiff", stripped: "none", embedded: [], skipped: [], error: "exiftool not found" });
    expect(readFileSync(f).equals(tiff())).toBe(true);
    expect(metadataNote([o])).toBe("TIFF metadata not stripped (exiftool not found)");
  });

  it("keep leaves a TIFF alone without calling exiftool", () => {
    pathWith(true);
    const f = put("t.tif", tiff());
    expect(finalizeFile(f, { keep: true }).stripped).toBe("kept");
    expect(calls()).toEqual([]);
  });
});
