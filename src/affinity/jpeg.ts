// Minimal JPEG header reader: width and height from the first SOF marker.
// Affinity renders are baseline JFIF (SOF0); progressive (SOF2) is handled too.

const isSof = (m: number): boolean =>
  m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

export function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) return null;
    let marker = buf[i + 1] ?? 0;
    while (marker === 0xff && i + 2 < buf.length) { // fill bytes
      i++;
      marker = buf[i + 1] ?? 0;
    }
    i += 2;
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      if (marker === 0xd9) return null; // EOI before any SOF
      continue;
    }
    if (i + 1 >= buf.length) return null;
    const len = buf.readUInt16BE(i);
    if (len < 2) return null;
    if (isSof(marker)) {
      if (i + 6 >= buf.length) return null;
      // segment: length(2) precision(1) height(2) width(2)
      const height = buf.readUInt16BE(i + 3);
      const width = buf.readUInt16BE(i + 5);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += len;
  }
  return null;
}
