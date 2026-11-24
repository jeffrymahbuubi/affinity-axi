// Pure PNG alpha reader and the safe-circle check behind `export --safe-zone`.
// Decodes only what the check needs (dimensions and the alpha plane) with node:zlib.

import { inflateSync } from "node:zlib";
import { AxiError } from "../output/errors.js";

export interface AlphaImage {
  width: number;
  height: number;
  /** One byte per pixel, row-major; null when the file has no alpha (every pixel counts as painted). */
  alpha: Uint8Array | null;
}

export interface SafeResult {
  ok: boolean;
  /** Distance in px from the centre to the farthest painted pixel centre. */
  farthest: number;
  /** Radius of the circle in px. */
  limit: number;
  at: { x: number; y: number } | null;
  painted: number;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PNG_SIDE = 4096;
const PAINTED_ABOVE = 25;
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const corrupt = (why: string): AxiError => new AxiError(`cannot check a corrupt PNG (${why})`, "export the file again, then retry");

function unfilter(raw: Buffer, width: number, height: number, bitsPerPixel: number): Buffer[] {
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  if (raw.length < height * (stride + 1)) throw corrupt("short pixel data");
  const rows: Buffer[] = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    const ft = raw[at]!;
    if (ft > 4) throw corrupt(`filter type ${ft}`);
    const cur = Buffer.from(raw.subarray(at + 1, at + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      let add = 0;
      if (ft === 1) add = a;
      else if (ft === 2) add = b;
      else if (ft === 3) add = (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = (cur[i]! + add) & 255;
    }
    rows.push(cur);
    prev = cur;
  }
  return rows;
}

/** Reads the size and the alpha plane of a non-interlaced PNG; AxiError for anything else. */
export function decodePngAlpha(buf: Buffer): AlphaImage {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new AxiError("cannot check safe zone: the export is not a PNG", "use a PNG preset and a .png path");
  }
  let pos = 8;
  let ihdr: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const end = pos + 8 + len;
    if (end + 4 > buf.length) throw corrupt("truncated chunk");
    const data = buf.subarray(pos + 8, end);
    if (type === "IHDR") ihdr = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos = end + 4;
  }
  if (!ihdr || ihdr.length < 13) throw corrupt("no header");
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const depth = ihdr[8]!;
  const colour = ihdr[9]!;
  if (ihdr[12] !== 0) throw new AxiError("cannot check an interlaced PNG", "export without interlacing, then retry");
  if (width < 1 || height < 1) throw corrupt("empty image");
  if (width > MAX_PNG_SIDE || height > MAX_PNG_SIDE) {
    throw new AxiError(`cannot check a PNG larger than ${MAX_PNG_SIDE} px on a side (${width}x${height})`, "export a smaller size, e.g. --sizes 512, then retry");
  }
  const channels = CHANNELS[colour];
  if (channels === undefined || ![1, 2, 4, 8, 16].includes(depth)) throw corrupt("unsupported colour type or bit depth");
  if (idat.length === 0) throw corrupt("no pixel data");
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    throw corrupt("bad compressed data");
  }
  const rows = unfilter(raw, width, height, channels * depth);
  if (colour === 0 || colour === 2 || (colour === 3 && !trns)) return { width, height, alpha: null };
  const alpha = new Uint8Array(width * height);
  const step = (channels * depth) / 8;
  for (let y = 0; y < height; y++) {
    const row = rows[y]!;
    for (let x = 0; x < width; x++) {
      let a: number;
      if (colour === 3) {
        const bit = x * depth;
        const idx = (row[bit >> 3]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        a = idx < trns!.length ? trns![idx]! : 255;
      } else {
        // the alpha sample is the last channel; for 16 bit its high byte comes first
        a = row[x * step + step - (depth === 16 ? 2 : 1)]!;
      }
      alpha[y * width + x] = a;
    }
  }
  return { width, height, alpha };
}

/** Whether every painted pixel (alpha above 25) lies inside the centred circle of `fraction` of the shorter side. */
export function safeCircle(img: AlphaImage, fraction: number): SafeResult {
  const { width: w, height: h, alpha } = img;
  const limit = (fraction * Math.min(w, h)) / 2;
  let farthest = 0;
  let at: { x: number; y: number } | null = null;
  let painted = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha !== null && alpha[y * w + x]! <= PAINTED_ABOVE) continue;
      painted++;
      const d = Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2);
      if (at === null || d > farthest) {
        farthest = d;
        at = { x, y };
      }
    }
  }
  if (at === null) return { ok: true, farthest: 0, limit, at: null, painted: 0 };
  return { ok: farthest <= limit + 0.5, farthest, limit, at, painted };
}
