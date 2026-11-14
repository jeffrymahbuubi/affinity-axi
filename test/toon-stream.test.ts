// toon list helpers: listHeader + listRow reproduce emitList byte for byte, which is
// what lets fill and batch stream their record tables row by row.

import { describe, expect, it } from "vitest";
import { emitList, listHeader, listRow } from "../src/output/toon.js";

const FIELDS = ["key", "status", "note"];

const SETS: Array<[string, Array<Record<string, unknown>>]> = [
  ["empty", []],
  ["plain", [{ key: "a", status: "ok", note: "" }, { key: "b", status: "failed", note: "x" }]],
  ["comma and quote", [{ key: "a,b", status: "ok", note: 'say "hi"' }, { key: "c", status: null, note: "l1\nl2" }]],
];

describe("listHeader and listRow", () => {
  for (const [label, rows] of SETS) {
    it(`join to emitList output (${label})`, () => {
      const streamed = [listHeader("records", rows.length, FIELDS), ...rows.map((r) => listRow(r, FIELDS))].join("\n");
      expect(streamed).toBe(emitList("records", rows, FIELDS));
    });
  }

  it("listHeader takes a number or a preformatted count", () => {
    expect(listHeader("records", 3, ["a", "b"])).toBe("records[3]{a,b}:");
    expect(listHeader("renamed", "2 of 5 total", ["value", "key"])).toBe("renamed[2 of 5 total]{value,key}:");
  });

  it("listRow indents and quotes like emitList", () => {
    expect(listRow({ key: "a,b", status: "ok" }, ["key", "status", "note"])).toBe('  "a,b",ok,');
  });

  it("emitList with total still renders 'N of M total'", () => {
    const rows = [{ key: "a" }, { key: "b" }];
    expect(emitList("renamed", rows, ["key"], { total: 5 })).toBe("renamed[2 of 5 total]{key}:\n  a\n  b");
  });
});
