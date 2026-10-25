// EXIF orientation reader (JPEG APP1 and TIFF IFD0): synthetic files, no Affinity, no exiftool.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { exifOrientation, orientationOps } from "../src/affinity/orientation.js";

const dir = mkdtempSync(join(tmpdir(), "axi-orient-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A TIFF header plus an IFD0 holding the orientation tag (and an unrelated tag before it). */
function tiff(orientation: number, little: boolean): Buffer {
  const w16 = (v: number): Buffer => {
    const b = Buffer.alloc(2);
    if (little) b.writeUInt16LE(v);
    else b.writeUInt16BE(v);
    return b;
  };
  const w32 = (v: number): Buffer => {
    const b = Buffer.alloc(4);
    if (little) b.writeUInt32LE(v);
    else b.writeUInt32BE(v);
    return b;
  };
  const entry = (tag: number, type: number, value: number): Buffer => Buffer.concat([w16(tag), w16(type), w32(1), w16(value), Buffer.alloc(2)]);
  return Buffer.concat([
    Buffer.from(little ? "II" : "MM", "latin1"),
    w16(42),
    w32(8),
    w16(2),
    entry(0x0100, 3, 640), // ImageWidth
    entry(0x0112, 3, orientation),
    w32(0),
  ]);
}

function segment(marker: number, body: Buffer): Buffer {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), len, body]);
}

/** SOI, APP0, optional Exif APP1, SOS, a little scan data, EOI. */
function jpeg(app1: Buffer | null): Buffer {
  const parts = [Buffer.from([0xff, 0xd8]), segment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"))];
  if (app1) parts.push(segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), app1])));
  parts.push(segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([1, 2, 3, 4, 0xff, 0xd9]));
  return Buffer.concat(parts);
}

function file(name: string, body: Buffer): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

describe("exifOrientation", () => {
  it("decodes orientation 1..8 from little- and big-endian JPEG APP1 segments", () => {
    for (let o = 1; o <= 8; o++) {
      expect(exifOrientation(file(`le${o}.jpg`, jpeg(tiff(o, true))))).toBe(o);
      expect(exifOrientation(file(`be${o}.jpg`, jpeg(tiff(o, false))))).toBe(o);
    }
  });

  it("finds the Exif segment after other APP segments and fill bytes", () => {
    const exif = segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff(6, true)]));
    // SOI, a stray 0xff (fill byte), APP0, an ICC APP2, then the Exif APP1
    const body = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), segment(0xe0, Buffer.from("JFIF\0", "latin1")), segment(0xe2, Buffer.from("ICC_PROFILE\0", "latin1")), exif]);
    expect(exifOrientation(file("fill.jpg", body))).toBe(6);
  });

  it("returns null for a JPEG without APP1 or with a non-Exif APP1", () => {
    expect(exifOrientation(file("plain.jpg", jpeg(null)))).toBeNull();
    const xmp = Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xe1, Buffer.from("http://ns.adobe.com/xap/1.0/\0<x/>", "latin1")), Buffer.from([0xff, 0xd9])]);
    expect(exifOrientation(file("xmp.jpg", xmp))).toBeNull();
  });

  it("returns null for a PNG, an unknown file, an empty file and a missing file", () => {
    expect(exifOrientation(file("a.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])))).toBeNull();
    expect(exifOrientation(file("junk.bin", Buffer.from("not an image at all")))).toBeNull();
    expect(exifOrientation(file("empty.jpg", Buffer.alloc(0)))).toBeNull();
    expect(exifOrientation(join(dir, "missing.jpg"))).toBeNull();
  });

  it("returns null for a truncated APP1 and for an out-of-range value or IFD offset", () => {
    const whole = jpeg(tiff(6, true));
    const cut = whole.indexOf(Buffer.from("Exif", "latin1")) + 14;
    expect(exifOrientation(file("cut.jpg", whole.subarray(0, cut)))).toBeNull();
    expect(exifOrientation(file("nine.jpg", jpeg(tiff(9, true))))).toBeNull();
    expect(exifOrientation(file("zero.jpg", jpeg(tiff(0, true))))).toBeNull();
    const far = tiff(6, true);
    far.writeUInt32LE(100000, 4);
    expect(exifOrientation(file("far.jpg", jpeg(far)))).toBeNull();
  });

  it("reads a bare TIFF file (II*\\0 and MM\\0*), 64-byte header included", () => {
    const small = Buffer.concat([tiff(6, true), Buffer.alloc(64 - tiff(6, true).length)]);
    expect(small.length).toBe(64);
    expect(exifOrientation(file("small.tif", small))).toBe(6);
    expect(exifOrientation(file("be.tiff", tiff(3, false)))).toBe(3);
  });

  it("returns null for a TIFF with a bad magic number", () => {
    const bad = tiff(6, true);
    bad.writeUInt16LE(43, 2);
    expect(exifOrientation(file("bad.tif", bad))).toBeNull();
  });
});

describe("orientationOps", () => {
  it("maps all eight values (exiftool's descriptions)", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((o) => orientationOps(o))).toEqual([
      { rotate: 0, mirror: false },
      { rotate: 0, mirror: true },
      { rotate: 180, mirror: false },
      { rotate: 180, mirror: true },
      { rotate: 270, mirror: true },
      { rotate: 90, mirror: false },
      { rotate: 90, mirror: true },
      { rotate: 270, mirror: false },
    ]);
  });

  it("treats anything else as upright", () => {
    expect(orientationOps(0)).toEqual({ rotate: 0, mirror: false });
    expect(orientationOps(9)).toEqual({ rotate: 0, mirror: false });
  });
});
