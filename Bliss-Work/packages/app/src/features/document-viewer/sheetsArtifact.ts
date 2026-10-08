import { z } from "zod";
import { parseCsv } from "./parseCsv";

/**
 * The spreadsheet preview the Office Document Sandbox returns for XLS/XLSX: the
 * sheet names and each sheet's cell text AS DISPLAYED, as CSV. Plain text only —
 * no formatting, formulas, macros or links survive the sandbox — so the client
 * parses nothing but text it already knows how to parse.
 *
 * It is still validated, not trusted: the shape, the sizes and the counts are
 * checked before anything is rendered.
 */

/** Display caps. They match the sandbox's own, and are enforced again here. */
export const SHEET_MAX_SHEETS = 64;
export const SHEET_MAX_ROWS = 5000;
export const SHEET_MAX_COLS = 200;
const SHEET_MAX_CHARS = 16 * 1024 * 1024;

const SheetSchema = z.object({
  name: z.string().max(255),
  csv: z.string().max(SHEET_MAX_CHARS),
  totalRows: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

const ArtifactSchema = z.object({
  sheets: z.array(SheetSchema).min(1).max(SHEET_MAX_SHEETS),
  moreSheets: z.boolean().optional(),
});

export interface SheetData {
  name: string;
  rows: string[][];
  /** Rows the sheet really has (the sandbox counts them all, then sends the first ones). */
  totalRows: number;
  /** Rows or columns were cut, by the sandbox or here. */
  truncated: boolean;
}

export interface SheetsPreview {
  sheets: SheetData[];
  /** The workbook has more sheets than the preview carries. */
  moreSheets: boolean;
}

/** Validate and parse the sandbox's JSON. Returns null for anything that is not that artifact. */
export function parseSheetsArtifact(raw: unknown): SheetsPreview | null {
  const parsed = ArtifactSchema.safeParse(raw);
  if (!parsed.success) return null;
  const sheets = parsed.data.sheets.map((s): SheetData => {
    // The sandbox always writes comma-separated text, so the delimiter is fixed
    // rather than guessed — a sheet whose first row is prose must not be re-split.
    const csv = parseCsv(s.csv, { maxRows: SHEET_MAX_ROWS, maxCols: SHEET_MAX_COLS, delimiter: "," });
    return {
      name: s.name,
      rows: csv.rows,
      totalRows: s.totalRows,
      truncated: s.truncated || csv.truncatedRows || csv.truncatedCols,
    };
  });
  return { sheets, moreSheets: parsed.data.moreSheets === true };
}
