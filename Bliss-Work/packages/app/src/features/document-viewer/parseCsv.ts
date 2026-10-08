/**
 * A small RFC-4180 CSV parser for the document viewer.
 *
 * Plain text in, strings out: nothing here interprets a cell, evaluates a
 * formula or builds markup, so a hostile file can at worst be a lot of text — and
 * the row/column caps bound even that. It stops reading as soon as the row cap is
 * reached rather than parsing the rest.
 */

export interface ParsedCsv {
  rows: string[][];
  /** More rows existed than `maxRows` and were not read. */
  truncatedRows: boolean;
  /** At least one row had more cells than `maxCols`, and the extras were dropped. */
  truncatedCols: boolean;
}

export interface CsvOptions {
  maxRows: number;
  maxCols: number;
  /** Defaults to a guess from the first line: comma, semicolon or tab. */
  delimiter?: string;
}

const CANDIDATES = [",", ";", "\t"] as const;

/** Picks the delimiter that splits the first line into the most cells, outside quotes. */
export function sniffDelimiter(text: string): string {
  let best = ",";
  let bestCount = 0;
  for (const d of CANDIDATES) {
    let inQuotes = false;
    let count = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') inQuotes = !inQuotes;
      else if (!inQuotes && (c === "\n" || c === "\r")) break;
      else if (!inQuotes && c === d) count++;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

export function parseCsv(input: string, opts: CsvOptions): ParsedCsv {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = opts.delimiter ?? sniffDelimiter(text);
  const rows: string[][] = [];
  let truncatedRows = false;
  let truncatedCols = false;

  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAny = false; // the current row has at least one character or delimiter

  const endField = () => {
    if (row.length < opts.maxCols) row.push(field);
    else truncatedCols = true;
    field = "";
  };
  // Returns false once the row cap has been hit, so the caller can stop.
  const endRow = (): boolean => {
    endField();
    if (rows.length >= opts.maxRows) {
      truncatedRows = true;
      return false;
    }
    rows.push(row);
    row = [];
    sawAny = false;
    return true;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "") {
      inQuotes = true;
      sawAny = true;
    } else if (c === delimiter) {
      endField();
      sawAny = true;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (!endRow()) return { rows, truncatedRows, truncatedCols };
    } else {
      field += c;
      sawAny = true;
    }
  }
  // A final record with no trailing newline. (A trailing newline leaves nothing pending.)
  if (sawAny || field !== "") {
    if (rows.length >= opts.maxRows) truncatedRows = true;
    else {
      endField();
      rows.push(row);
    }
  }
  return { rows, truncatedRows, truncatedCols };
}
