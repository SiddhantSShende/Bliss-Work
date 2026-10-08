import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import { Button } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { activityRanges, computeRange, localDay, type RangeKey } from "../lib/dateRange";
import { exportAllMembersActivityToXlsx, exportMemberActivityToXlsx } from "../lib/xlsxTelemetry";
import { Modal } from "./Modal";

/**
 * Download the activity record as .xlsx — the whole workspace, or one member.
 *
 * The directory is fetched with `includeInactive` because a report covering the
 * last quarter will contain people who have since left, and a spreadsheet whose
 * name column is blank for them is worse than useless.
 */
export function ExportActivityDialog({
  open,
  onClose,
  member,
}: {
  open: boolean;
  onClose: () => void;
  /** Present = export this one person. Absent = the whole workspace. */
  member?: { id: string; displayName: string };
}) {
  const { t } = useTranslation("shell");
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [range, setRange] = useState<RangeKey>("30d");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  // The fixed windows come from lib/dateRange.ts (shared with the activity
  // views); only this dialog adds a "custom" option on top.
  const ranges: ReadonlyArray<{ key: RangeKey; label: string }> = [
    ...activityRanges(),
    { key: "custom", label: t("exportActivity.customRange") },
  ];

  const run = useMutation({
    mutationFn: async () => {
      const { from, to } = computeRange(range, { from: fromDate, to: toDate });
      const rows = await api.exportActivity({
        scope: member ? "member" : "org",
        userId: member?.id,
        from,
        to,
      });
      if (rows.length === 0) return 0;

      // Admin-only flag; the server ignores it for a non-admin, and a member
      // exporting their own record needs only their own name.
      const directory = await qc.fetchQuery({
        queryKey: qk.directory,
        queryFn: () => api.directory(true),
      });

      const stamp = localDay(new Date());
      if (member) {
        const sessions = await api.activitySessions(member.id, { limit: 100 });
        return exportMemberActivityToXlsx(
          rows, sessions.sessions, directory,
          `blisswork-activity-${slug(member.displayName)}-${stamp}.xlsx`,
        );
      }
      return exportAllMembersActivityToXlsx(
        rows, directory, `blisswork-activity-all-${stamp}.xlsx`,
      );
    },
    onSuccess: (n) => {
      if (n === 0) {
        toast.info(t("exportActivity.toasts.nothingToExport"));
        return;
      }
      toast.success(t("exportActivity.toasts.exported", { count: n }));
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : t("exportActivity.toasts.exportFailedFallback")),
  });

  return (
    <Modal
      open={open}
      onClose={() => !run.isPending && onClose()}
      title={
        member
          ? t("exportActivity.title.forMember", { name: member.displayName })
          : t("exportActivity.title.workspace")
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap gap-1.5">
          {ranges.map((r) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                range === r.key ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted hover:text-fg"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>

        {range === "custom" && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label className="flex items-center gap-2">
              <span className="text-muted">{t("exportActivity.from")}</span>
              <input
                type="date"
                value={fromDate}
                max={toDate || undefined}
                onChange={(e) => setFromDate(e.target.value)}
                className="rounded-lg border border-border bg-surface px-2 py-1"
              />
            </label>
            <label className="flex items-center gap-2">
              <span className="text-muted">{t("exportActivity.to")}</span>
              <input
                type="date"
                value={toDate}
                min={fromDate || undefined}
                onChange={(e) => setToDate(e.target.value)}
                className="rounded-lg border border-border bg-surface px-2 py-1"
              />
            </label>
          </div>
        )}

        <p className="text-xs leading-relaxed text-muted">
          {t("exportActivity.description")}
        </p>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={run.isPending} onClick={onClose}>
            {t("exportActivity.cancel")}
          </Button>
          <Button size="sm" loading={run.isPending} onClick={() => run.mutate()}>
            <Download size={15} /> {t("exportActivity.exportButton")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "member";
}
