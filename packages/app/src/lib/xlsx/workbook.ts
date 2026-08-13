/**
 * The one place a workbook is built and handed to the browser.
 *
 * exceljs is a pure-JS (no wasm) library, imported LAZILY here so it lands in its
 * own chunk — off the app's initial bundle, only fetched when someone clicks
 * Export. Compatible with `script-src 'self'` (bundled, no CDN/eval), which is
 * what keeps it usable in the web app and the MS-Store desktop package alike.
 *
 * Extracted from xlsxExport.ts when a second exporter appeared. The task export
 * keeps its exact public signature and simply calls through here, so the sheet it
 * produces is byte-for-byte what it always was.
 */
import { downloadBlob } from "../download";

export interface SheetColumn {
  header: string;
  key: string;
  width: number;
}

export interface SheetSpec<T extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  columns: SheetColumn[];
  rows: T[];
  /** Column keys whose long text should wrap rather than run under its neighbour. */
  wrapKeys?: string[];
}

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Excel forbids : \ / ? * [ ] in sheet names and caps them at 31 characters.
 *  A name built from user data (a person's display name) will eventually contain
 *  one, and exceljs throws rather than sanitising. */
export function safeSheetName(name: string, fallback = "Sheet"): string {
  const cleaned = name.replace(/[:\\/?*[\]]/g, " ").trim().slice(0, 31);
  return cleaned || fallback;
}

/** Build the workbook, trigger the download, return the total rows written. */
export async function buildAndDownload(
  sheets: SheetSpec[],
  filename: string,
): Promise<number> {
  // Lazy chunk — keeps exceljs out of the initial bundle.
  const mod = await import("exceljs");
  const ExcelJS = (mod as unknown as { default?: typeof mod }).default ?? mod;

  const wb = new ExcelJS.Workbook();
  wb.created = new Date();

  let total = 0;
  const used = new Set<string>();
  for (const spec of sheets) {
    // Duplicate sheet names also throw in exceljs; two members sharing a display
    // name is entirely ordinary.
    let name = safeSheetName(spec.name);
    for (let i = 2; used.has(name); i++) name = safeSheetName(`${spec.name} ${i}`);
    used.add(name);

    const ws = wb.addWorksheet(name);
    ws.columns = spec.columns;
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).alignment = { vertical: "middle" };
    for (const row of spec.rows) {
      ws.addRow(row);
      total++;
    }
    for (const key of spec.wrapKeys ?? []) {
      ws.getColumn(key).alignment = { wrapText: true, vertical: "top" };
    }
  }

  const buffer = await wb.xlsx.writeBuffer();
  downloadBlob(new Blob([buffer], { type: XLSX_MIME }), filename);
  return total;
}
