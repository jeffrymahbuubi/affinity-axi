// jpegSize: the header walk, built from hand-made marker segments (no image library).

import { describe, expect, it } from "vitest";
import { jpegSize } from "../src/affinity/jpeg.js";

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];
const u16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];

/** A length-prefixed segment: marker, length (counts itself), payload. */
const segment = (marker: number, payload: number[]): number[] => [0xff, marker, ...u16(payload.length + 2), ...payload];

/** SOF payload: precision, height, width, one component. */
const sof = (marker: number, width: number, height: number): number[] =>
  segment(marker, [8, ...u16(height), ...u16(width), 1, 1, 0x11, 0]);

const buf = (...parts: number[][]): Buffer => Buffer.from(parts.flat());

describe("jpegSize", () => {
  it("reads width and height from a baseline SOF0", () => {
    expect(jpegSize(buf(SOI, sof(0xc0, 640, 480), EOI))).toEqual({ width: 640, height: 480 });
  });

  it("reads a progressive SOF2 and other extended SOF markers", () => {
    expect(jpegSize(buf(SOI, sof(0xc2, 1920, 1080)))).toEqual({ width: 1920, height: 1080 });
    expect(jpegSize(buf(SOI, sof(0xc1, 33, 17)))).toEqual({ width: 33, height: 17 });
    expect(jpegSize(buf(SOI, sof(0xcf, 9, 8)))).toEqual({ width: 9, height: 8 });
  });

  it("skips APPn and DHT/DAC/JPG segments (not SOF markers) before the SOF", () => {
    const app0 = segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0]);
    const dht = segment(0xc4, [0, 1, 2, 3]);
    const jpg = segment(0xc8, [0, 0]);
    const dac = segment(0xcc, [0, 0]);
    expect(jpegSize(buf(SOI, app0, dht, jpg, dac, sof(0xc0, 100, 50)))).toEqual({ width: 100, height: 50 });
  });

  it("skips fill bytes (extra 0xFF) before a marker", () => {
    const sofBytes = sof(0xc0, 12, 34);
    expect(jpegSize(buf(SOI, [0xff, 0xff, 0xff], sofBytes.slice(1)))).toEqual({ width: 12, height: 34 });
  });

  it("steps over standalone markers (TEM, RSTn) that carry no length", () => {
    expect(jpegSize(buf(SOI, [0xff, 0x01], [0xff, 0xd0], [0xff, 0xd7], sof(0xc0, 7, 5)))).toEqual({ width: 7, height: 5 });
  });

  it("returns null when EOI arrives before any SOF", () => {
    expect(jpegSize(buf(SOI, segment(0xe0, [1, 2, 3]), EOI, [0, 0]))).toBeNull();
  });

  it("returns null for a JPEG that ends without a SOF", () => {
    expect(jpegSize(buf(SOI, segment(0xe0, [1, 2, 3, 4, 5, 6])))).toBeNull();
  });

  it("returns null when the SOI is missing or the buffer is shorter than four bytes", () => {
    expect(jpegSize(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBeNull();
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
    expect(jpegSize(Buffer.alloc(0))).toBeNull();
  });

  it("returns null when a marker does not start with 0xFF", () => {
    expect(jpegSize(buf(SOI, [0x00, 0xc0, 0x00, 0x11, 8, 0, 1, 0, 1]))).toBeNull();
  });

  it("returns null when a segment length is below 2", () => {
    expect(jpegSize(buf(SOI, [0xff, 0xe0, 0x00, 0x01, 0, 0, 0, 0]))).toBeNull();
  });

  it("returns null for a truncated buffer: cut inside the length field, the SOF body or the fill bytes", () => {
    const full = buf(SOI, sof(0xc0, 640, 480));
    expect(jpegSize(full.subarray(0, 10))).toBeNull(); // cut inside the SOF body
    expect(jpegSize(buf(SOI, [0xff, 0xe0, 0x00]))).toBeNull(); // length field cut
    expect(jpegSize(buf(SOI, [0xff, 0xff, 0xff, 0xff]))).toBeNull(); // only fill bytes
  });

  it("returns null for a SOF that declares a zero width or height", () => {
    expect(jpegSize(buf(SOI, sof(0xc0, 0, 480)))).toBeNull();
    expect(jpegSize(buf(SOI, sof(0xc0, 640, 0)))).toBeNull();
  });
});
