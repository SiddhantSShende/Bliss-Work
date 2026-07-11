/**
 * Client-side .xlsx builder for the Tasks export.
 *
 * exceljs is a pure-JS (no wasm) library, imported LAZILY here so it lands in
 * its own chunk — off the app's initial bundle, only fetched when a user clicks
 * Export. Compatible with `script-src 'self'` (bundled, no CDN/eval) → safe for
 * the web app and the MS-Store desktop package.
 *
 * Timestamps are rendered in the USER'S LOCAL timezone (their device) — the
 * requirement — and the resolved tz name is put in the timestamp column headers
 * so the sheet is self-describing. Emails are joined from the org directory
 * (auth-svc already exposes name+email to the client), which task-svc rows lack.
 */
import type { TaskExportRow, UserDTO } from "@taskboard/shared";
import { downloadBlob } from "./download";

/** The viewer's IANA timezone (e.g. "Asia/Kolkata"), for the column headers. */
function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  } catch {
    return "local time";
  }
}

/** Format an ISO-8601 instant to the device's local date+time, or "" when absent. */
function fmtLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Human-readable duration from seconds (e.g. "2d 3h 5m"), or "" when absent. */
function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || seconds < 0) return "";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (!d && !h && !m) parts.push(`${s}s`);
  return parts.join(" ");
}

const STATUS_LABEL: Record<string, string> = {
  SENT: "Sent (awaiting)",
  ACKNOWLEDGED: "Acknowledged",
  COMPLETED: "Completed",
  IGNORED: "Ignored",
  LEFT: "Left",
};

/**
 * Build the workbook from export rows + the org directory, then trigger a
 * download. Returns the number of rows written.
 */
export async function exportTaskRowsToXlsx(
  rows: TaskExportRow[],
  directory: UserDTO[],
  filename: string,
): Promise<number> {
  // Lazy chunk — keeps exceljs out of the initial bundle.
  const mod = await import("exceljs");
  const ExcelJS = (mod as unknown as { default?: typeof mod }).default ?? mod;

  const tz = localTimeZone();
  const byId = new Map(directory.map((u) => [u.id, u]));
  const nameOf = (id: string, fallback: string) => byId.get(id)?.displayName || fallback || id;
  const emailOf = (id: string) => byId.get(id)?.email ?? "";

  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const ws = wb.addWorksheet("Task Timeline");

  ws.columns = [
    { header: "Task", key: "title", width: 30 },
    { header: "Description", key: "description", width: 40 },
    { header: "Allocated by", key: "byName", width: 22 },
    { header: "Allocated by (email)", key: "byEmail", width: 28 },
    { header: "Allocated to", key: "toName", width: 22 },
    { header: "Allocated to (email)", key: "toEmail", width: 28 },
    { header: "Status", key: "status", width: 16 },
    { header: `Allocated at (${tz})`, key: "allocatedAt", width: 24 },
    { header: `Acknowledged at (${tz})`, key: "acknowledgedAt", width: 24 },
    { header: `Ignored at (${tz})`, key: "ignoredAt", width: 24 },
    { header: `Completed at (${tz})`, key: "completedAt", width: 24 },
    { header: `Left at (${tz})`, key: "leftAt", width: 24 },
    { header: "Time to complete", key: "timeTaken", width: 18 },
    { header: `Reviewed at (${tz})`, key: "reviewedAt", width: 24 },
    { header: "Review", key: "review", width: 40 },
    { header: "Rating", key: "rating", width: 10 },
  ];

  // Bold header row.
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: "middle" };

  for (const r of rows) {
    ws.addRow({
      title: r.title,
      description: r.description,
      byName: nameOf(r.allocatedById, r.allocatedByUsername),
      byEmail: emailOf(r.allocatedById),
      toName: nameOf(r.allocatedToId, r.allocatedToUsername),
      toEmail: emailOf(r.allocatedToId),
      status: STATUS_LABEL[r.status] ?? r.status,
      allocatedAt: fmtLocal(r.allocatedAt),
      acknowledgedAt: fmtLocal(r.acknowledgedAt),
      ignoredAt: fmtLocal(r.ignoredAt),
      completedAt: fmtLocal(r.completedAt),
      leftAt: fmtLocal(r.leftAt),
      timeTaken: fmtDuration(r.timeTakenSeconds),
      reviewedAt: fmtLocal(r.reviewedAt),
      review: r.review ?? "",
      rating: r.reviewRating ?? "",
    });
  }

  // Wrap long text columns so they stay readable.
  for (const key of ["description", "review"]) {
    ws.getColumn(key).alignment = { wrapText: true, vertical: "top" };
  }

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  downloadBlob(blob, filename);
  return rows.length;
}
