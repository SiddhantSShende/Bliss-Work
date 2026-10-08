/**
 * Export the task timeline to .xlsx.
 *
 * The user picks a SCOPE (tasks I allocated / assigned to me / both) and a date
 * RANGE. Named ranges are turned into explicit local-tz `from`/`to` instants
 * HERE (the server never computes "this week" — it would use UTC and mis-bucket
 * edges); we hand the server ISO-UTC bounds and it filters on `assigned_at`.
 * The rows come back as JSON; the .xlsx is assembled client-side (emails joined
 * from the org directory, timestamps rendered in the device's local tz).
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import { Button } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { localDay, subtractDays, subtractMonthsClamped } from "../lib/dateRange";
import { exportTaskRowsToXlsx } from "../lib/xlsxExport";
import { Modal } from "./Modal";
import { Tabs, type TabSpec } from "./Tabs";

type Scope = "all" | "sent" | "received";
type RangeKey = "week" | "month" | "year" | "all" | "custom";

const SCOPE_KEYS: Scope[] = ["all", "sent", "received"];
const RANGE_KEYS: RangeKey[] = ["week", "month", "year", "all", "custom"];

const EXPORT_ROW_CAP = 5000;

/** Turn the selected range into ISO-UTC `from`/`to` from LOCAL-tz boundaries. */
function computeRange(
  range: RangeKey,
  fromDate: string,
  toDate: string,
): { from?: string; to?: string } {
  if (range === "all") return {};
  if (range === "custom") {
    const out: { from?: string; to?: string } = {};
    if (fromDate) out.from = new Date(`${fromDate}T00:00:00`).toISOString();
    if (toDate) {
      // Inclusive end: bump to the start of the next local day (server uses < to).
      const end = new Date(`${toDate}T00:00:00`);
      end.setDate(end.getDate() + 1);
      out.to = end.toISOString();
    }
    return out;
  }
  if (range === "month") return { from: subtractMonthsClamped(new Date(), 1).toISOString() };
  if (range === "year") return { from: subtractMonthsClamped(new Date(), 12).toISOString() };
  return { from: subtractDays(new Date(), 7).toISOString() }; // range === "week"
}

export function ExportTasksDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation("tasks");
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [scope, setScope] = useState<Scope>("all");
  const [range, setRange] = useState<RangeKey>("month");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const scopeLabel: Record<Scope, string> = {
    all: t("exportTasksDialog.scopes.all"),
    sent: t("exportTasksDialog.scopes.sent"),
    received: t("exportTasksDialog.scopes.received"),
  };
  const rangeLabel: Record<RangeKey, string> = {
    week: t("exportTasksDialog.ranges.week"),
    month: t("exportTasksDialog.ranges.month"),
    year: t("exportTasksDialog.ranges.year"),
    all: t("exportTasksDialog.ranges.all"),
    custom: t("exportTasksDialog.ranges.custom"),
  };
  const scopes: TabSpec<Scope>[] = SCOPE_KEYS.map((key) => ({ key, label: scopeLabel[key] }));
  const ranges: TabSpec<RangeKey>[] = RANGE_KEYS.map((key) => ({ key, label: rangeLabel[key] }));

  const run = useMutation({
    mutationFn: async () => {
      const { from, to } = computeRange(range, fromDate, toDate);
      const rows = await api.exportTasks({ scope, from, to });
      // Reuse the cached org directory (name+email) or fetch it once.
      const directory = await qc.fetchQuery({
        queryKey: qk.directory,
        queryFn: () => api.directory(),
      });
      const stamp = localDay(new Date());
      const n = await exportTaskRowsToXlsx(
        rows,
        directory,
        `blisswork-tasks-${scope}-${stamp}.xlsx`,
      );
      return n;
    },
    onSuccess: (n) => {
      if (n === 0) {
        toast(t("exportTasksDialog.toasts.nothingTitle"), {
          description: t("exportTasksDialog.toasts.nothingDescription"),
        });
        return;
      }
      toast.success(t("exportTasksDialog.toasts.exported", { count: n }));
      if (n >= EXPORT_ROW_CAP)
        toast(t("exportTasksDialog.toasts.cappedTitle"), {
          description: t("exportTasksDialog.toasts.cappedDescription", { cap: EXPORT_ROW_CAP }),
        });
      onClose();
    },
    onError: (e) => toast.error(t("exportTasksDialog.toasts.failedTitle"), { description: String(e) }),
  });

  const customIncomplete = range === "custom" && (!fromDate || !toDate);

  return (
    <Modal open={open} onClose={onClose} title={t("exportTasksDialog.title")}>
      <div className="flex flex-col gap-4">
        <section>
          <div className="mb-1.5 text-sm font-medium text-fg">{t("exportTasksDialog.scopeHeading")}</div>
          <Tabs tabs={scopes} active={scope} onChange={setScope} className="flex-wrap" />
        </section>

        <section>
          <div className="mb-1.5 text-sm font-medium text-fg">{t("exportTasksDialog.rangeHeading")}</div>
          <Tabs tabs={ranges} active={range} onChange={setRange} className="flex-wrap" />
          {range === "custom" && (
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-xs text-muted">
                {t("exportTasksDialog.from")}
                <input
                  type="date"
                  value={fromDate}
                  max={toDate || undefined}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg focus-visible:border-accent focus-visible:outline-none"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted">
                {t("exportTasksDialog.to")}
                <input
                  type="date"
                  value={toDate}
                  min={fromDate || undefined}
                  onChange={(e) => setToDate(e.target.value)}
                  className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg focus-visible:border-accent focus-visible:outline-none"
                />
              </label>
            </div>
          )}
        </section>

        <p className="text-[11px] text-muted">
          {t("exportTasksDialog.footerNote")}
        </p>

        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("exportTasksDialog.actions.cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => run.mutate()}
            loading={run.isPending}
            disabled={customIncomplete}
          >
            <Download size={15} /> {run.isPending ? t("exportTasksDialog.actions.exporting") : t("exportTasksDialog.actions.export")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
