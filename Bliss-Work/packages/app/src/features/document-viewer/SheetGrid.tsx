import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SheetData } from "./sheetsArtifact";

/** Rows drawn at first, and added per "Show more". Keeps the DOM small however big the sheet is. */
const FIRST_ROWS = 200;
const MORE_ROWS = 400;

/** 0 → A, 25 → Z, 26 → AA … */
export function columnLabel(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/**
 * A READ-ONLY view of a spreadsheet's (or CSV's) cell text. Not an Excel
 * renderer: it shows values and structure only, and says so in a notice that is
 * always visible. Cells are React text nodes — never markup — so whatever a file
 * contains is just text.
 */
export function SheetGrid({
  sheets,
  moreSheets,
  fromCsv,
}: {
  sheets: SheetData[];
  moreSheets: boolean;
  /** A CSV file: no sheet tabs, and the total row count is not known. */
  fromCsv: boolean;
}) {
  const { t } = useTranslation("common");
  const [active, setActive] = useState(0);
  const [shown, setShown] = useState(FIRST_ROWS);
  const sheet = sheets[Math.min(active, sheets.length - 1)];
  if (!sheet) return null;

  const rows = sheet.rows.slice(0, shown);
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const hidden = sheet.rows.length - rows.length;
  const cut = sheet.truncated;

  return (
    <div
      className="flex h-full max-h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg bg-surface text-fg"
      onClick={(e) => e.stopPropagation()}
    >
      <p className="border-b border-border bg-surface-2 px-3 py-2 text-xs text-muted">
        {t(fromCsv ? "documentViewer.csvNotice" : "documentViewer.sheetNotice")}
      </p>

      {sheets.length > 1 && (
        <div role="tablist" aria-label={t("documentViewer.sheets")} className="flex gap-1 overflow-x-auto border-b border-border px-2 pt-2">
          {sheets.map((s, i) => (
            <button
              key={`${i}:${s.name}`}
              type="button"
              role="tab"
              aria-selected={i === active}
              onClick={() => {
                setActive(i);
                setShown(FIRST_ROWS);
              }}
              className={`max-w-[12rem] shrink-0 truncate rounded-t-md px-3 py-1.5 text-xs ${
                i === active ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-surface-2"
              }`}
              title={s.name}
            >
              {s.name || `${i + 1}`}
            </button>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="p-6 text-center text-sm text-muted">{t("documentViewer.emptySheet")}</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-surface-2">
              <tr>
                <th className="w-10 border border-border px-2 py-1" aria-hidden="true" />
                {Array.from({ length: cols }, (_, c) => (
                  <th key={c} className="min-w-[4rem] border border-border px-2 py-1 font-medium text-muted">
                    {columnLabel(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  <th scope="row" className="border border-border bg-surface-2 px-2 py-1 text-right font-normal text-muted">
                    {r + 1}
                  </th>
                  {Array.from({ length: cols }, (_, c) => {
                    const cell = row[c] ?? "";
                    return (
                      <td key={c} className="max-w-[24rem] truncate border border-border px-2 py-1" title={cell}>
                        {cell}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3 py-2 text-xs text-muted">
        {hidden > 0 && (
          <button type="button" onClick={() => setShown((n) => n + MORE_ROWS)} className="text-accent underline underline-offset-2">
            {t("documentViewer.showMoreRows")}
          </button>
        )}
        {cut && (
          <span>
            {!fromCsv && sheet.totalRows > sheet.rows.length
              ? t("documentViewer.showingRowsOf", { shown: sheet.rows.length, total: sheet.totalRows })
              : t("documentViewer.showingRows", { shown: sheet.rows.length })}
          </span>
        )}
        {moreSheets && <span>{t("documentViewer.moreSheets", { count: sheets.length })}</span>}
      </div>
    </div>
  );
}
