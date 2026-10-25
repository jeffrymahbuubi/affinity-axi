// EXIF orientation (tag 0x0112) of a JPEG or TIFF file, read on the Node side.
//
// Affinity's Bitmap.loadFromFile ignores EXIF orientation, so a phone photo taken
// upright arrives sideways. This module is a pure parser: no exiftool, no sips, no
// temp files. HEIC keeps its orientation in HEIF boxes and is not parsed (null).

import { closeSync, openSync, readSync } from "node:fs";

const READ_LIMIT = 256 * 1024;
const TAG_ORIENTATION = 0x0112;
const TYPE_SHORT = 3;

/** Reads at most READ_LIMIT bytes from the start of the file; null when it cannot be read. */
function head(path: string): Buffer | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(READ_LIMIT);
    const n = readSync(fd, buf, 0, READ_LIMIT, 0);
    return buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // nothing to do
      }
    }
  }
}

/** Orientation from a TIFF header at `base` in `buf` (IFD0, tag 0x0112); null when absent or malformed. */
function tiffOrientation(buf: Buffer, base: number): number | null {
  if (base + 8 > buf.length) return null;
  const le = buf[base] === 0x49 && buf[base + 1] === 0x49;
  const be = buf[base] === 0x4d && buf[base + 1] === 0x4d;
  if (!le && !be) return null;
  const u16 = (o: number): number => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number): number => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  if (u16(base + 2) !== 42) return null;
  const ifd = base + u32(base + 4);
  if (ifd + 2 > buf.length) return null;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > buf.length) return null;
    if (u16(e) !== TAG_ORIENTATION) continue;
    if (u16(e + 2) !== TYPE_SHORT || u32(e + 4) < 1) return null;
    const v = u16(e + 8);
    return v >= 1 && v <= 8 ? v : null;
  }
  return null;
}

/** Orientation from a JPEG: walks the markers up to the first scan and reads the Exif APP1 segment. */
function jpegOrientation(buf: Buffer): number | null {
  let p = 2;
  while (p + 4 <= buf.length) {
    if (buf[p] !== 0xff) return null;
    const marker = buf[p + 1]!;
    if (marker === 0xff) {
      p += 1; // fill byte
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null; // SOS / EOI: no Exif before the image data
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      p += 2; // markers without a length
      continue;
    }
    const len = buf.readUInt16BE(p + 2);
    if (len < 2) return null;
    if (marker === 0xe1 && buf.toString("latin1", p + 4, p + 10) === "Exif\0\0") {
      return tiffOrientation(buf.subarray(0, Math.min(buf.length, p + 2 + len)), p + 10);
    }
    p += 2 + len;
  }
  return null;
}

/** EXIF orientation 1..8 of a JPEG or TIFF file; null when absent, unreadable or another format. */
export function exifOrientation(path: string): number | null {
  const buf = head(path);
  if (buf === null || buf.length < 8) return null;
  try {
    if (buf[0] === 0xff && buf[1] === 0xd8) return jpegOrientation(buf);
    const tag = buf.toString("latin1", 0, 4);
    if (tag === "II*\0" || tag === "MM\0*") return tiffOrientation(buf, 0);
  } catch {
    return null;
  }
  return null;
}

/**
 * The transform that makes an image with this orientation upright: mirror horizontally
 * first, then rotate clockwise. (exiftool: 5 = mirror horizontal and rotate 270 CW,
 * 7 = mirror horizontal and rotate 90 CW.)
 */
export function orientationOps(o: number): { rotate: 0 | 90 | 180 | 270; mirror: boolean } {
  switch (o) {
    case 2:
      return { rotate: 0, mirror: true };
    case 3:
      return { rotate: 180, mirror: false };
    case 4:
      return { rotate: 180, mirror: true };
    case 5:
      return { rotate: 270, mirror: true };
    case 6:
      return { rotate: 90, mirror: false };
    case 7:
      return { rotate: 90, mirror: true };
    case 8:
      return { rotate: 270, mirror: false };
    default:
      return { rotate: 0, mirror: false };
  }
}
