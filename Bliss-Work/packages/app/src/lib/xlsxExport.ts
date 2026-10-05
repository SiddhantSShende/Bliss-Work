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
import i18n from "../i18n";

function statusLabel(status: string): string {
  const key = `tasks:xlsxExport.status.${status}`;
  const label = i18n.t(key);
  return label === key ? status : label;
}

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

  const t = (key: string) => i18n.t(`tasks:xlsxExport.${key}`, { tz });

  return buildAndDownload(
    [
      {
        name: t("sheetName"),
        columns: [
          { header: t("columns.task"), key: "title", width: 30 },
          { header: t("columns.description"), key: "description", width: 40 },
          { header: t("columns.allocatedBy"), key: "byName", width: 22 },
          { header: t("columns.allocatedByEmail"), key: "byEmail", width: 28 },
          { header: t("columns.allocatedTo"), key: "toName", width: 22 },
          { header: t("columns.allocatedToEmail"), key: "toEmail", width: 28 },
          { header: t("columns.status"), key: "status", width: 16 },
          { header: t("columns.allocatedAt"), key: "allocatedAt", width: 24 },
          { header: t("columns.acknowledgedAt"), key: "acknowledgedAt", width: 24 },
          { header: t("columns.ignoredAt"), key: "ignoredAt", width: 24 },
          { header: t("columns.completedAt"), key: "completedAt", width: 24 },
          { header: t("columns.leftAt"), key: "leftAt", width: 24 },
          { header: t("columns.timeToComplete"), key: "timeTaken", width: 18 },
          { header: t("columns.reviewedAt"), key: "reviewedAt", width: 24 },
          { header: t("columns.review"), key: "review", width: 40 },
          { header: t("columns.rating"), key: "rating", width: 10 },
        ],
        rows: rows.map((r) => ({
          title: r.title,
          description: r.description,
          byName: nameOf(r.allocatedById, r.allocatedByUsername),
          byEmail: emailOf(r.allocatedById),
          toName: nameOf(r.allocatedToId, r.allocatedToUsername),
          toEmail: emailOf(r.allocatedToId),
          status: statusLabel(r.status),
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
