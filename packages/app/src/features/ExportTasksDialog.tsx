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
import { Download } from "lucide-react";
import { Button } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { exportTaskRowsToXlsx } from "../lib/xlsxExport";
import { Modal } from "./Modal";

type Scope = "all" | "sent" | "received";
type RangeKey = "week" | "month" | "year" | "all" | "custom";

const SCOPES: { key: Scope; label: string }[] = [
  { key: "all", label: "All my tasks" },
  { key: "sent", label: "Allocated by me" },
  { key: "received", label: "Assigned to me" },
];

const RANGES: { key: RangeKey; label: string }[] = [
  { key: "week", label: "Past week" },
  { key: "month", label: "Past month" },
  { key: "year", label: "Past year" },
  { key: "all", label: "All time" },
  { key: "custom", label: "Custom range" },
];

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
  const from = new Date();
  if (range === "week") from.setDate(from.getDate() - 7);
  else if (range === "month") from.setMonth(from.getMonth() - 1);
  else if (range === "year") from.setFullYear(from.getFullYear() - 1);
  return { from: from.toISOString() };
}

export function ExportTasksDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [scope, setScope] = useState<Scope>("all");
  const [range, setRange] = useState<RangeKey>("month");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const run = useMutation({
    mutationFn: async () => {
      const { from, to } = computeRange(range, fromDate, toDate);
      const rows = await api.exportTasks({ scope, from, to });
      // Reuse the cached org directory (name+email) or fetch it once.
      const directory = await qc.fetchQuery({
        queryKey: qk.directory,
        queryFn: () => api.directory(),
      });
      const stamp = new Date().toISOString().slice(0, 10);
      const n = await exportTaskRowsToXlsx(
        rows,
        directory,
        `blisswork-tasks-${scope}-${stamp}.xlsx`,
      );
      return n;
    },
    onSuccess: (n) => {
      if (n === 0) {
        toast("Nothing to export", { description: "No tasks in the selected range." });
        return;
      }
      toast.success(`Exported ${n} row${n === 1 ? "" : "s"} to Excel`);
      if (n >= EXPORT_ROW_CAP)
        toast("Export was capped", {
          description: `Only the most recent ${EXPORT_ROW_CAP} rows were included — narrow the date range for the rest.`,
        });
      onClose();
    },
    onError: (e) => toast.error("Export failed", { description: String(e) }),
  });

  const customIncomplete = range === "custom" && (!fromDate || !toDate);

  return (
    <Modal open={open} onClose={onClose} title="Export tasks to Excel">
      <div className="flex flex-col gap-4">
        <section>
          <div className="mb-1.5 text-sm font-medium text-fg">Which tasks</div>
          <div className="flex flex-wrap gap-1.5">
            {SCOPES.map((s) => (
              <Chip key={s.key} active={scope === s.key} onClick={() => setScope(s.key)}>
                {s.label}
              </Chip>
            ))}
          </div>
        </section>

        <section>
          <div className="mb-1.5 text-sm font-medium text-fg">Time range</div>
          <div className="flex flex-wrap gap-1.5">
            {RANGES.map((r) => (
              <Chip key={r.key} active={range === r.key} onClick={() => setRange(r.key)}>
                {r.label}
              </Chip>
            ))}
          </div>
          {range === "custom" && (
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-xs text-muted">
                From
                <input
                  type="date"
                  value={fromDate}
                  max={toDate || undefined}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg focus-visible:border-accent focus-visible:outline-none"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted">
                To
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
          Times are exported in your device's local timezone. One row per person the
          task was allocated to.
        </p>

        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => run.mutate()}
            loading={run.isPending}
            disabled={customIncomplete}
          >
            <Download size={15} /> {run.isPending ? "Exporting…" : "Export"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Chip({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
        active ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}
