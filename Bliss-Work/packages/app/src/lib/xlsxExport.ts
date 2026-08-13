/**
 * Client-side .xlsx builder for the Tasks export.
 *
 * The workbook mechanics (the lazy exceljs import, the bold header row, the
 * download) moved to lib/xlsx/workbook.ts and the cell formatters to
 * lib/xlsx/format.ts when the activity export needed the same three. This file
 * keeps its EXACT public signature and produces the same 16-column sheet it
 * always has — the call site in ExportTasksDialog.tsx is unchanged.
 *
 * Timestamps are rendered in the USER'S LOCAL timezone (their device) — the
 * requirement — and the resolved tz name is put in the timestamp column headers
 * so the sheet is self-describing. Emails are joined from the org directory
 * (auth-svc already exposes name+email to the client), which task-svc rows lack.
 */
import type { TaskExportRow, UserDTO } from "@taskboard/shared";
import { fmtDuration, fmtLocal, localTimeZone } from "./xlsx/format";
import { buildAndDownload } from "./xlsx/workbook";

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
  const tz = localTimeZone();
  const byId = new Map(directory.map((u) => [u.id, u]));
  const nameOf = (id: string, fallback: string) => byId.get(id)?.displayName || fallback || id;
  const emailOf = (id: string) => byId.get(id)?.email ?? "";

  return buildAndDownload(
    [
      {
        name: "Task Timeline",
        columns: [
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
        ],
        rows: rows.map((r) => ({
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
        })),
        wrapKeys: ["description", "review"],
      },
    ],
    filename,
  );
}
