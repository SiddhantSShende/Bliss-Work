import { describe, expect, it } from "vitest";
import { parseSheetsArtifact } from "./sheetsArtifact";

const sheet = (over: Record<string, unknown> = {}) => ({
  name: "Sheet1",
  csv: "a,b\n1,2\n",
  totalRows: 2,
  truncated: false,
  ...over,
});

describe("parseSheetsArtifact", () => {
  it("parses a valid artifact into rows", () => {
    const p = parseSheetsArtifact({ sheets: [sheet(), sheet({ name: "Zwei", csv: '"x, y",z\n' })], moreSheets: false });
    expect(p).not.toBeNull();
    expect(p!.sheets.map((s) => s.name)).toEqual(["Sheet1", "Zwei"]);
    expect(p!.sheets[0]!.rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(p!.sheets[1]!.rows).toEqual([["x, y", "z"]]);
    expect(p!.moreSheets).toBe(false);
  });

  it("keeps the sandbox's own truncation flag and total row count", () => {
    const p = parseSheetsArtifact({ sheets: [sheet({ totalRows: 90000, truncated: true })] });
    expect(p!.sheets[0]).toMatchObject({ totalRows: 90000, truncated: true });
  });

  it("uses a comma even when the first row would look semicolon-separated", () => {
    const p = parseSheetsArtifact({ sheets: [sheet({ csv: "a;b;c,d\n" })] });
    expect(p!.sheets[0]!.rows).toEqual([["a;b;c", "d"]]);
  });

  it("flags truncation it performs itself", () => {
    const wide = Array.from({ length: 300 }, (_, i) => i).join(",");
    const p = parseSheetsArtifact({ sheets: [sheet({ csv: wide + "\n" })] });
    expect(p!.sheets[0]!.rows[0]).toHaveLength(200);
    expect(p!.sheets[0]!.truncated).toBe(true);
  });

  it("reports moreSheets only when it is exactly true", () => {
    expect(parseSheetsArtifact({ sheets: [sheet()], moreSheets: true })!.moreSheets).toBe(true);
    expect(parseSheetsArtifact({ sheets: [sheet()] })!.moreSheets).toBe(false);
  });

  it.each([
    ["null", null],
    ["a string", "{}"],
    ["no sheets", { sheets: [] }],
    ["sheets missing", {}],
    ["too many sheets", { sheets: Array.from({ length: 65 }, () => sheet()) }],
    ["a sheet with no name", { sheets: [{ csv: "", totalRows: 0, truncated: false }] }],
    ["a non-string csv", { sheets: [sheet({ csv: 42 })] }],
    ["a negative row count", { sheets: [sheet({ totalRows: -1 })] }],
    ["a fractional row count", { sheets: [sheet({ totalRows: 1.5 })] }],
    ["an over-long name", { sheets: [sheet({ name: "x".repeat(256) })] }],
    ["a non-boolean truncated", { sheets: [sheet({ truncated: "yes" })] }],
  ])("rejects %s", (_l, raw) => {
    expect(parseSheetsArtifact(raw)).toBeNull();
  });

  it("returns cell text verbatim: markup is just text", () => {
    const p = parseSheetsArtifact({ sheets: [sheet({ csv: "<script>alert(1)</script>,=1+1\n" })] });
    expect(p!.sheets[0]!.rows[0]).toEqual(["<script>alert(1)</script>", "=1+1"]);
  });
});
