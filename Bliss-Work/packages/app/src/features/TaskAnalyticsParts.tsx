import { useTranslation } from "react-i18next";
import { Card } from "@taskboard/ui";
import type {
  AssigneeWorkloadDTO,
  StatusBreakdownDTO,
} from "@taskboard/shared";

/** One headline number with an optional tooltip explaining exactly what it
 *  measures — required reading before trusting either completion metric (see
 *  the "never conflate the two rates" rule in domain.ts). */
export function KpiTile({
  label,
  value,
  hint,
  tooltip,
}: {
  label: string;
  value: string;
  hint?: string;
  tooltip?: string;
}) {
  return (
    <Card className="flex flex-col gap-1 p-4" title={tooltip}>
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="text-2xl font-semibold tabular-nums text-fg">{value}</div>
      {hint && <div className="text-[11px] text-muted">{hint}</div>}
    </Card>
  );
}

/** A completion percentage as a ring, drawn with two stroke segments on one
 *  circle — the same "hand-rolled inline SVG" convention as
 *  member/MemberAnalyticsCharts.tsx, no charting library. */
export function CompletionRing({
  percent,
  label,
}: {
  percent: number;
  label: string;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  const r = 38;
  const c = 2 * Math.PI * r;
  const filled = (clamped / 100) * c;
  return (
    <div className="flex items-center gap-4">
      <svg
        viewBox="0 0 96 96"
        width={96}
        height={96}
        role="img"
        aria-label={`${label}: ${Math.round(clamped)}%`}
      >
        <circle
          cx={48}
          cy={48}
          r={r}
          fill="none"
          stroke="var(--color-chart-grid)"
          strokeWidth={10}
        />
        <circle
          cx={48}
          cy={48}
          r={r}
          fill="none"
          stroke="var(--color-chart-ink)"
          strokeWidth={10}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${c - filled}`}
          transform="rotate(-90 48 48)"
        />
        <text
          x={48}
          y={52}
          textAnchor="middle"
          fontSize={18}
          fontWeight={600}
          fill="currentColor"
          className="text-fg"
        >
          {Math.round(clamped)}%
        </text>
      </svg>
      <div className="text-sm text-muted">{label}</div>
    </div>
  );
}

const STATUS_COLORS: Record<keyof StatusBreakdownDTO, string> = {
  completed: "var(--color-success)",
  acknowledged: "var(--color-chart-ink)",
  sent: "var(--color-chart-context)",
  missed: "var(--color-danger)",
  ignored: "var(--color-muted)",
  left: "var(--color-muted)",
};

/** The six-category status breakdown as one stacked bar + a legend. Renders a
 *  flat empty track (no divide-by-zero, no NaN widths) when every count is 0. */
export function StatusBreakdownBar({
  breakdown,
}: {
  breakdown: StatusBreakdownDTO;
}) {
  const { t } = useTranslation("tasks");
  const order: (keyof StatusBreakdownDTO)[] = [
    "completed",
    "acknowledged",
    "sent",
    "missed",
    "left",
    "ignored",
  ];
  const total = order.reduce((sum, k) => sum + breakdown[k], 0);
  return (
    <div>
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full"
        style={{ background: "var(--color-chart-grid)" }}
        role="img"
        aria-label={t("tasks:analytics.channel.title")}
      >
        {total > 0 &&
          order
            .filter((k) => breakdown[k] > 0)
            .map((k) => (
              <span
                key={k}
                style={{
                  width: `${(breakdown[k] / total) * 100}%`,
                  background: STATUS_COLORS[k],
                }}
                title={`${t(`tasks:analytics.statuses.${k}`)}: ${breakdown[k]}`}
              />
            ))}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {order.map((k) => (
          <div key={k} className="flex items-center gap-1.5 text-xs">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: STATUS_COLORS[k] }}
            />
            <dt className="text-muted">{t(`tasks:analytics.statuses.${k}`)}</dt>
            <dd className="font-medium tabular-nums text-fg">{breakdown[k]}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Per-assignee workload as horizontal bars, in the order the server returns
 *  (assigned desc). Empty list renders nothing — the caller decides the
 *  surrounding empty state. */
export function WorkloadBars({
  workload,
}: {
  workload: AssigneeWorkloadDTO[];
}) {
  if (workload.length === 0) return null;
  const max = Math.max(1, ...workload.map((w) => w.assignedCount));
  return (
    <ul className="m-0 list-none space-y-3 p-0">
      {workload.map((w) => (
        <li key={w.assigneeId} className="flex items-center gap-3">
          <span
            className="w-28 shrink-0 truncate text-sm text-fg"
            title={w.assigneeUsername}
          >
            {w.assigneeUsername}
          </span>
          <div className="min-w-0 flex-1">
            <div
              className="h-2 w-full overflow-hidden rounded-full"
              style={{ background: "var(--color-chart-grid)" }}
            >
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(3, (w.assignedCount / max) * 100)}%`,
                  background: "var(--color-chart-ink)",
                }}
              />
            </div>
          </div>
          <span className="shrink-0 text-xs tabular-nums text-muted">
            {w.completedCount}/{w.assignedCount} ({Math.round(w.completionRate)}
            %)
          </span>
        </li>
      ))}
    </ul>
  );
}
