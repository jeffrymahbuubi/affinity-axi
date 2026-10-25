// `templates`: the pure pieces of the command (photo placeholder PNG, --args parsing).
// No server, no Affinity.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseTemplateArgs, solidPng } from "../src/commands/templates.js";
import { templateByName } from "../src/templates/index.js";

describe("solidPng", () => {
  it("writes a valid one-colour RGBA PNG", () => {
    const png = solidPng("#4C8DFF", 8);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(16)).toBe(8);
    expect(png.readUInt32BE(20)).toBe(8);
    const idat: Buffer[] = [];
    const types: string[] = [];
    for (let off = 8; off < png.length; off += 12 + png.readUInt32BE(off)) {
      const type = png.subarray(off + 4, off + 8).toString("ascii");
      types.push(type);
      if (type === "IDAT") idat.push(png.subarray(off + 8, off + 8 + png.readUInt32BE(off)));
    }
    expect(types).toEqual(["IHDR", "IDAT", "IEND"]);
    const raw = inflateSync(Buffer.concat(idat));
    expect(raw.length).toBe((8 * 4 + 1) * 8);
    expect([...raw.subarray(1, 5)]).toEqual([0x4c, 0x8d, 0xff, 255]);
  });
});

describe("parseTemplateArgs", () => {
  const post = templateByName("ig-post")!;
  const price = templateByName("price-post")!;

  it("accepts nothing, a photo that exists, and rows", () => {
    expect(parseTemplateArgs(post, undefined)).toEqual({});
    const p = join(mkdtempSync(join(tmpdir(), "axi-tpl-args-")), "p.png");
    writeFileSync(p, "x");
    expect(parseTemplateArgs(post, JSON.stringify({ photo: p }))).toEqual({ photo: p });
    expect(parseTemplateArgs(price, '{"rows":[["a","b"],[1,2]]}')).toEqual({ rows: [["a", "b"], [1, 2]] });
  });

  it("rejects bad json, unknown keys and keys the template cannot use", () => {
    expect(() => parseTemplateArgs(post, "{")).toThrow(/not valid JSON/);
    expect(() => parseTemplateArgs(post, "[]")).toThrow(/JSON object/);
    expect(() => parseTemplateArgs(post, '{"title":"x"}')).toThrow(/unknown --args key/);
    expect(() => parseTemplateArgs(post, '{"rows":[["a"]]}')).toThrow(/has no table/);
    expect(() => parseTemplateArgs(price, '{"photo":"x.png"}')).toThrow(/no photo slot/);
    expect(() => parseTemplateArgs(post, '{"photo":"nope.png"}')).toThrow(/photo not found/);
    expect(() => parseTemplateArgs(post, '{"photo":"notes.txt"}')).toThrow(/\.png, \.jpg, \.jpeg, \.webp, \.heic, \.heif, \.tif or \.tiff/);
    expect(() => parseTemplateArgs(price, '{"rows":[["a"],["b","c"]]}')).toThrow(/same 1 to 4 cells/);
  });
});
