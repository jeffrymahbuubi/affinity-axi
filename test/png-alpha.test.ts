import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodePngAlpha, safeCircle } from "../src/affinity/png-alpha.js";

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]); // CRC is not checked
}

interface Opts {
  depth?: number;
  colour: number;
  trns?: Buffer;
  interlace?: number;
  filter?: number;
}

/** Builds a PNG from raw (unfiltered) scanlines; `filter` applies one filter type to every row. */
function png(w: number, h: number, rows: Buffer[], o: Opts): Buffer {
  const depth = o.depth ?? 8;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = depth;
  ihdr[9] = o.colour;
  ihdr[12] = o.interlace ?? 0;
  const ft = o.filter ?? 0;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[o.colour]!;
  const bpp = Math.max(1, Math.ceil((channels * depth) / 8));
  let prev = Buffer.alloc(rows[0]!.length);
  const filtered = rows.map((row) => {
    const out = Buffer.alloc(row.length + 1);
    out[0] = ft;
    for (let i = 0; i < row.length; i++) {
      const a = i >= bpp ? row[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      let pred = 0;
      if (ft === 1) pred = a;
      else if (ft === 2) pred = b;
      else if (ft === 3) pred = (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[i + 1] = (row[i]! - pred) & 255;
    }
    prev = row;
    return out;
  });
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr)];
  if (o.trns) parts.push(chunk("tRNS", o.trns));
  parts.push(chunk("IDAT", deflateSync(Buffer.concat(filtered))), chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

const rgba = (w: number, h: number, a: (x: number, y: number) => number, o: Partial<Opts> = {}): Buffer =>
  png(w, h, Array.from({ length: h }, (_, y) => Buffer.from(Array.from({ length: w }, (_, x) => [10 + x, 20 + y, 30, a(x, y)]).flat())), { colour: 6, ...o });

const grad = (x: number, y: number): number => (x * 40 + y * 10) & 255;

describe("decodePngAlpha", () => {
  it("reads RGBA 8 bit", () => {
    const img = decodePngAlpha(rgba(4, 3, grad));
    expect([img.width, img.height]).toEqual([4, 3]);
    expect(Array.from(img.alpha!)).toEqual(Array.from({ length: 12 }, (_, i) => grad(i % 4, Math.floor(i / 4))));
  });

  it("reads RGBA 16 bit (high byte)", () => {
    const rows = [0, 1].map((y) => Buffer.from([0, 1, 0, 2, 0, 3, 200 + y, 99, 0, 0, 0, 0, 0, 0, 7, 255]));
    const img = decodePngAlpha(png(2, 2, rows, { colour: 6, depth: 16 }));
    expect(Array.from(img.alpha!)).toEqual([200, 7, 201, 7]);
  });

  it("reads grey+alpha 8 and 16 bit", () => {
    const g8 = png(2, 1, [Buffer.from([5, 11, 6, 22])], { colour: 4 });
    expect(Array.from(decodePngAlpha(g8).alpha!)).toEqual([11, 22]);
    const g16 = png(2, 1, [Buffer.from([0, 5, 90, 1, 0, 6, 33, 2])], { colour: 4, depth: 16 });
    expect(Array.from(decodePngAlpha(g16).alpha!)).toEqual([90, 33]);
  });

  it("reads a palette with tRNS, missing entries are opaque", () => {
    const img = decodePngAlpha(png(4, 1, [Buffer.from([0, 1, 2, 3])], { colour: 3, trns: Buffer.from([0, 128]) }));
    expect(Array.from(img.alpha!)).toEqual([0, 128, 255, 255]);
  });

  it("reads a 2-bit palette with tRNS", () => {
    // indices 0,1,2,3 packed into one byte: 00 01 10 11
    const img = decodePngAlpha(png(4, 1, [Buffer.from([0b00011011])], { colour: 3, depth: 2, trns: Buffer.from([10, 20, 30, 40]) }));
    expect(Array.from(img.alpha!)).toEqual([10, 20, 30, 40]);
  });

  it("returns alpha null without an alpha channel", () => {
    expect(decodePngAlpha(png(2, 1, [Buffer.from([1, 2, 3, 4, 5, 6])], { colour: 2 })).alpha).toBeNull();
    expect(decodePngAlpha(png(2, 1, [Buffer.from([1, 2])], { colour: 0 })).alpha).toBeNull();
    expect(decodePngAlpha(png(2, 1, [Buffer.from([0, 1])], { colour: 3 })).alpha).toBeNull();
  });

  it.each([0, 1, 2, 3, 4])("decodes filter type %i", (filter) => {
    const img = decodePngAlpha(rgba(5, 4, grad, { filter }));
    expect(Array.from(img.alpha!)).toEqual(Array.from({ length: 20 }, (_, i) => grad(i % 5, Math.floor(i / 5))));
  });

  it("rejects non-PNG, interlaced, oversized and corrupt input", () => {
    expect(() => decodePngAlpha(Buffer.from("not a png at all"))).toThrow(/not a PNG/);
    expect(() => decodePngAlpha(rgba(2, 2, grad, { interlace: 1 }))).toThrow("cannot check an interlaced PNG");
    const big = png(4097, 1, [Buffer.alloc(4097 * 4)], { colour: 6 });
    expect(() => decodePngAlpha(big)).toThrow(/larger than 4096/);
    const ok = rgba(4, 4, grad);
    expect(() => decodePngAlpha(ok.subarray(0, ok.length - 30))).toThrow(/corrupt/);
    const noData = Buffer.concat([ok.subarray(0, 8), ok.subarray(8, 8 + 25)]);
    expect(() => decodePngAlpha(noData)).toThrow(/corrupt/);
    const short = png(4, 4, [Buffer.alloc(16), Buffer.alloc(16)], { colour: 6 });
    expect(() => decodePngAlpha(short)).toThrow(/corrupt/);
  });
});

function disc(size: number, radius: number, extra?: Array<[number, number]>): Uint8Array {
  const a = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) <= radius) a[y * size + x] = 255;
    }
  }
  for (const [x, y] of extra ?? []) a[y * size + x] = 255;
  return a;
}

describe("safeCircle", () => {
  it("accepts a disc of radius 100 inside the 66/108 circle (limit 132)", () => {
    const r = safeCircle({ width: 432, height: 432, alpha: disc(432, 100) }, 66 / 108);
    expect(r.ok).toBe(true);
    expect(r.limit).toBeCloseTo(132, 5);
    expect(Math.abs(r.farthest - 100)).toBeLessThan(1);
    expect(r.painted).toBeGreaterThan(30000);
  });

  it("rejects a disc of radius 140 with `at` on its rim", () => {
    const r = safeCircle({ width: 432, height: 432, alpha: disc(432, 140) }, 66 / 108);
    expect(r.ok).toBe(false);
    expect(Math.abs(r.farthest - 140)).toBeLessThan(1);
    const d = Math.hypot(r.at!.x + 0.5 - 216, r.at!.y + 0.5 - 216);
    expect(d).toBeCloseTo(r.farthest, 5);
  });

  it("flags one painted corner pixel", () => {
    const a = new Uint8Array(100 * 100);
    a[0] = 255;
    const r = safeCircle({ width: 100, height: 100, alpha: a }, 0.8);
    expect(r.ok).toBe(false);
    expect(r.at).toEqual({ x: 0, y: 0 });
    expect(r.painted).toBe(1);
  });

  it("is ok for an empty image", () => {
    const r = safeCircle({ width: 10, height: 10, alpha: new Uint8Array(100) }, 0.5);
    expect(r).toEqual({ ok: true, farthest: 0, limit: 2.5, at: null, painted: 0 });
  });

  it("counts every pixel of an image without alpha", () => {
    const r = safeCircle({ width: 10, height: 10, alpha: null }, 1);
    expect(r.painted).toBe(100);
    expect(r.ok).toBe(false);
    expect(r.at).toEqual({ x: 0, y: 0 });
  });

  it("counts alpha 26 but not 25", () => {
    const a = new Uint8Array(100 * 100);
    a[0] = 25;
    expect(safeCircle({ width: 100, height: 100, alpha: a }, 0.8).painted).toBe(0);
    a[0] = 26;
    expect(safeCircle({ width: 100, height: 100, alpha: a }, 0.8).painted).toBe(1);
  });

  it("uses the shorter side for the limit", () => {
    expect(safeCircle({ width: 200, height: 100, alpha: new Uint8Array(20000) }, 0.5).limit).toBe(25);
  });
});
