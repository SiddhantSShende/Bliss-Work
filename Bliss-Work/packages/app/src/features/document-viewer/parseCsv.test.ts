import { describe, expect, it } from "vitest";
import { parseCsv, sniffDelimiter } from "./parseCsv";

const caps = { maxRows: 1000, maxCols: 100 };

describe("parseCsv", () => {
  it("parses plain rows", () => {
    expect(parseCsv("a,b,c\n1,2,3\n", caps).rows).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quotes, escaped quotes, embedded delimiters and embedded newlines", () => {
    const r = parseCsv('name,quote\n"Smith, J.","He said ""hi"""\n"multi\nline",x\n', caps);
    expect(r.rows).toEqual([
      ["name", "quote"],
      ["Smith, J.", 'He said "hi"'],
      ["multi\nline", "x"],
    ]);
  });

  it("accepts CRLF, CR and LF line endings, and a BOM", () => {
    expect(parseCsv("﻿a,b\r\n1,2\r\n", caps).rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv("a,b\r1,2", caps).rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("does not invent a row for a trailing newline, and keeps a final unterminated row", () => {
    expect(parseCsv("a\n", caps).rows).toEqual([["a"]]);
    expect(parseCsv("a\nb", caps).rows).toEqual([["a"], ["b"]]);
    expect(parseCsv("", caps).rows).toEqual([]);
  });

  it("keeps blank lines in the middle as empty rows so row numbers stay faithful", () => {
    expect(parseCsv("a\n\nb\n", caps).rows).toEqual([["a"], [""], ["b"]]);
  });

  it("keeps empty cells and ragged rows", () => {
    expect(parseCsv("a,,c\n1\n,,\n", caps).rows).toEqual([["a", "", "c"], ["1"], ["", "", ""]]);
  });

  it("tolerates a stray quote in the middle of an unquoted field", () => {
    expect(parseCsv('5" pipe,ok\n', caps).rows).toEqual([['5" pipe', "ok"]]);
  });

  it("tolerates an unterminated quote by taking the rest of the input as the field", () => {
    expect(parseCsv('a,"never closed\nstill going', caps).rows).toEqual([["a", "never closed\nstill going"]]);
  });

  it("stops at the row cap and says so", () => {
    const text = Array.from({ length: 50 }, (_, i) => `r${i},x`).join("\n");
    const r = parseCsv(text, { maxRows: 10, maxCols: 100 });
    expect(r.rows).toHaveLength(10);
    expect(r.truncatedRows).toBe(true);
    expect(r.rows[9]).toEqual(["r9", "x"]);
  });

  it("does not flag truncation when the file is exactly at the cap", () => {
    const r = parseCsv("a\nb\nc\n", { maxRows: 3, maxCols: 100 });
    expect(r.rows).toHaveLength(3);
    expect(r.truncatedRows).toBe(false);
  });

  it("drops cells past the column cap and says so", () => {
    const r = parseCsv("1,2,3,4,5\n", { maxRows: 10, maxCols: 3 });
    expect(r.rows).toEqual([["1", "2", "3"]]);
    expect(r.truncatedCols).toBe(true);
  });

  it("returns cells as inert strings: markup and formulas are text, not interpreted", () => {
    const r = parseCsv("<img src=x onerror=alert(1)>,=1+1,@SUM(A1)\n", { ...caps, delimiter: "," });
    expect(r.rows[0]).toEqual(["<img src=x onerror=alert(1)>", "=1+1", "@SUM(A1)"]);
  });

  it("copes with a large file within the caps", () => {
    const text = Array.from({ length: 20000 }, (_, i) => `${i},${"x".repeat(40)},y`).join("\n");
    const t0 = Date.now();
    const r = parseCsv(text, { maxRows: 5000, maxCols: 200 });
    expect(r.rows).toHaveLength(5000);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("sniffDelimiter", () => {
  it.each([
    ["a,b,c\n1,2,3", ","],
    ["a;b;c\n1;2;3", ";"],
    ["a\tb\tc\n1\t2\t3", "\t"],
    ['"a,b";c;d\n', ";"],
    ["just one column\nnext", ","],
    ["", ","],
  ])("%j → %j", (text, want) => {
    expect(sniffDelimiter(text)).toBe(want);
  });

  it("only looks at the first line", () => {
    expect(sniffDelimiter("a,b\n1;2;3;4;5;6")).toBe(",");
  });
});
