// A 4-component JPEG (CMYK) gets the web-use note; a 3-component one does not.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finalizeFile, jpegComponents, metadataNote } from "../src/affinity/metadata.js";

/** SOI, an APP0, an SOF segment with `n` components, SOS, entropy bytes, EOI. */
function jpeg(n: number, sof = 0xc0): Buffer {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF\0"), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])]);
  const comps = Buffer.concat(Array.from({ length: n }, (_, i) => Buffer.from([i + 1, 0x11, 0])));
  const sofSeg = Buffer.concat([Buffer.from([0xff, sof, 0, 8 + 3 * n, 8, 0, 4, 0, 4, n]), comps]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0x34, 0xff, 0xd9]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sofSeg, sos]);
}

const CMYK_NOTE = "JPEG is CMYK (the document is CMYK); web and social platforms expect RGB: export PNG, or export from an RGB copy";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "axi-cmyk-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const put = (name: string, data: Buffer): string => {
  const f = join(dir, name);
  writeFileSync(f, data);
  return f;
};

describe("jpegComponents", () => {
  it("reads the component count from SOF0 and progressive SOF2", () => {
    expect(jpegComponents(jpeg(4))).toBe(4);
    expect(jpegComponents(jpeg(3))).toBe(3);
    expect(jpegComponents(jpeg(1))).toBe(1);
    expect(jpegComponents(jpeg(4, 0xc2))).toBe(4);
  });

  it("is null without a SOF before SOS, and for non-JPEG bytes", () => {
    expect(jpegComponents(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]))).toBeNull();
    expect(jpegComponents(Buffer.from("not a jpeg"))).toBeNull();
  });
});

describe("CMYK JPEG note", () => {
  it("flags a 4-component JPEG and adds the note", () => {
    const o = finalizeFile(put("c.jpg", jpeg(4)), {});
    expect(o.kind).toBe("jpeg");
    expect(o.cmyk).toBe(true);
    expect(metadataNote([o])).toBe(CMYK_NOTE);
  });

  it("flags it even with --keep-metadata, and appends to other notes", () => {
    const o = finalizeFile(put("k.jpg", jpeg(4)), { keep: true });
    expect(o.cmyk).toBe(true);
    expect(metadataNote([o])).toBe(`Affinity XMP kept, ${CMYK_NOTE}`);
  });

  it("does not flag a 3-component JPEG", () => {
    const o = finalizeFile(put("r.jpg", jpeg(3)), {});
    expect(o.cmyk).toBeUndefined();
    expect(metadataNote([o])).toBeNull();
  });

  it("says it once for several CMYK files", () => {
    const a = finalizeFile(put("a.jpg", jpeg(4)), {});
    const b = finalizeFile(put("b.jpg", jpeg(4)), {});
    expect(metadataNote([a, b])).toBe(CMYK_NOTE);
  });
});
