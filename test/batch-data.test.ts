// batch-data: CSV strictness after a closing quote (R12), the reserved-field
// helper (R16) and key sanitizing for non-Latin scripts (R20). Pure, no server.

import { describe, expect, it } from "vitest";
import { BATCH_RESERVED, parseCsv, reservedFields, sanitizeKey } from "../src/commands/batch-data.js";
import { UsageError } from "../src/output/errors.js";

describe("parseCsv: text after a closing quote (R12)", () => {
  it("rejects text that follows a closing quote", () => {
    expect(() => parseCsv('a,"b"c')).toThrow(/text follows a closing quote/);
    expect(() => parseCsv('"b"c,d')).toThrow(/text follows a closing quote/);
    expect(() => parseCsv('"b" ,d')).toThrow(/text follows a closing quote/);
  });

  it("carries the frozen message and suggestion", () => {
    try {
      parseCsv('a,"b"c');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as UsageError).message).toBe("malformed CSV: text follows a closing quote");
      expect((err as UsageError).suggestion).toBe('quote the whole field and double any inner quotes ("")');
    }
  });

  it("still parses valid quoted fields", () => {
    expect(parseCsv('a,"b",c\n')).toEqual([["a", "b", "c"]]);
    expect(parseCsv('"x"\r\n"y"')).toEqual([["x"], ["y"]]);
    expect(parseCsv('a,"b"')).toEqual([["a", "b"]]);
    expect(parseCsv('"say ""hi""",z\r\n')).toEqual([['say "hi"', "z"]]);
    expect(parseCsv('"a"\r"b"')).toEqual([["a"], ["b"]]);
  });

  it("clears the state after a field or row ends", () => {
    expect(parseCsv('"a",b\nc,d')).toEqual([["a", "b"], ["c", "d"]]);
    expect(parseCsv('"a"\nb')).toEqual([["a"], ["b"]]);
  });
});

describe("reservedFields (R16)", () => {
  it("lists the names batch replaces in ARGS", () => {
    expect(BATCH_RESERVED).toEqual(["key", "index", "outDir", "outBase"]);
  });

  it("returns [] when no record uses a reserved name", () => {
    expect(reservedFields([{ slug: "a" }])).toEqual([]);
    expect(reservedFields([])).toEqual([]);
  });

  it("returns each reserved name once, in BATCH_RESERVED order", () => {
    expect(reservedFields([{ key: 1 }, { outBase: 2, key: 3 }])).toEqual(["key", "outBase"]);
    expect(reservedFields([{ outDir: "x", index: 1 }])).toEqual(["index", "outDir"]);
  });
});

describe("sanitizeKey: letters and digits of any script (R20)", () => {
  it("keeps non-Latin letters and digits", () => {
    expect(sanitizeKey("北京", "k")).toBe("北京");
    expect(sanitizeKey("Москва 2", "k")).toBe("Москва-2");
    expect(sanitizeKey("서울", "k")).toBe("서울");
  });

  it("strips Latin diacritics", () => {
    expect(sanitizeKey("Ärger", "k")).toBe("Arger");
    expect(sanitizeKey("../Hello World/é!", "k")).toBe("Hello-World-e");
  });

  it("still falls back and trims", () => {
    expect(sanitizeKey("!!!", "k")).toBe("k");
    expect(sanitizeKey("..a..", "k")).toBe("a");
    expect(sanitizeKey("a/b", "k")).toBe("a-b");
  });
});
