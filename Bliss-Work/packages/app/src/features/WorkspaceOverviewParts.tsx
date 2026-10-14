import { useTranslation } from "react-i18next";
import type {
  ChannelPerformanceDTO,
  DailyActivityPointDTO,
  StatusBreakdownDTO,
  WorkloadBreakdownDTO,
} from "@taskboard/shared";
import { KpiTile, STATUS_COLORS } from "./TaskAnalyticsParts";

const STATUS_ORDER = Object.keys(STATUS_COLORS) as (keyof StatusBreakdownDTO)[];

function pct(n: number, d: number): number {
  return d > 0 ? (n / d) * 100 : 0;
}

/** Ranked list of channels by task volume, name resolved by the caller (task-svc
 *  only knows channel ids — see WorkspaceOverview's nameOf). Same row layout as
 *  TaskAnalyticsParts' WorkloadBars: label, progress bar, trailing fraction. */
export function ChannelPerformanceList({
  channels,
  nameOf,
  emptyHint,
}: {
  channels: ChannelPerformanceDTO[];
  nameOf: (channelId: string) => string;
  emptyHint: string;
}) {
  if (channels.length === 0) return <p className="py-3 text-sm text-muted">{emptyHint}</p>;
  return (
    <ul className="m-0 list-none space-y-3 p-0">
      {channels.map((c) => {
        const name = nameOf(c.channelId);
        return (
          <li key={c.channelId} className="flex items-center gap-3">
            <span className="w-28 shrink-0 truncate text-sm text-fg" title={name}>
              {name}
            </span>
            <div className="min-w-0 flex-1">
              <div
                className="h-2 w-full overflow-hidden rounded-full"
                style={{ background: "var(--color-chart-grid)" }}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.max(3, c.completionRate)}%`,
                    background: "var(--color-chart-ink)",
                  }}
                />
              </div>
            </div>
            <span className="shrink-0 text-xs tabular-nums text-muted">
              {c.completedUniqueTasks}/{c.totalUniqueTasks} ({Math.round(c.completionRate)}%)
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** A real <table> — a lookup ("who's carrying what"), not a shape to read, the
 *  same reasoning OrgActivity.tsx uses for its one table. */
export function WorkloadMatrixTable({
  workload,
  nameOf,
  emptyHint,
}: {
  workload: WorkloadBreakdownDTO[];
  nameOf: (assigneeId: string) => string;
  emptyHint: string;
}) {
  const { t } = useTranslation("tasks");
  if (workload.length === 0) return <p className="py-3 text-sm text-muted">{emptyHint}</p>;
  return (
    <div className="overflow-x-auto rounded-xl border border-border/60">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border/60 text-left text-xs text-muted">
            <th className="px-3 py-2 font-medium">{t("tasks:analyticsHub.overview.workloadTable.person")}</th>
            <th className="px-3 py-2 text-right font-medium">
              {t("tasks:analyticsHub.overview.workloadTable.assigned")}
            </th>
            <th className="px-3 py-2 text-right font-medium">
              {t("tasks:analyticsHub.overview.workloadTable.completed")}
            </th>
            <th className="px-3 py-2 text-right font-medium">
              {t("tasks:analyticsHub.overview.workloadTable.inProgress")}
            </th>
            <th className="px-3 py-2 font-medium">{t("tasks:analyticsHub.overview.workloadTable.progress")}</th>
          </tr>
        </thead>
        <tbody>
          {workload.map((w) => {
            const name = nameOf(w.assigneeId);
            return (
              <tr key={w.assigneeId} className="border-b border-border/40 last:border-0">
                <td className="px-3 py-2 text-fg" title={name}>
                  {name}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted">{w.assignedCount}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted">{w.completedCount}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted">{w.inProgressCount}</td>
                <td className="px-3 py-2">
                  <div
                    className="h-2 w-20 overflow-hidden rounded-full"
                    style={{ background: "var(--color-chart-grid)" }}
                  >
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max(3, w.completionRate)}%`,
                        background: "var(--color-success)",
                      }}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const SCATTER_W = 480;
const SCATTER_H = 200;
const SCATTER_PAD = { left: 36, right: 12, top: 10, bottom: 24 };

/** Assigned workload (x) against completion rate (y, fixed 0..100), one point
 *  per person — the same `workload` array WorkloadMatrixTable renders as a
 *  table, read here as a shape instead of a lookup. */
export function WorkloadScatterChart({
  workload,
  nameOf,
  emptyHint,
}: {
  workload: WorkloadBreakdownDTO[];
  nameOf: (assigneeId: string) => string;
  emptyHint: string;
}) {
  const { t } = useTranslation("tasks");
  if (workload.length === 0) return <p className="py-3 text-sm text-muted">{emptyHint}</p>;
  const maxAssigned = Math.max(1, ...workload.map((w) => w.assignedCount));
  const x = (v: number) =>
    SCATTER_PAD.left + (v / maxAssigned) * (SCATTER_W - SCATTER_PAD.left - SCATTER_PAD.right);
  const y = (v: number) =>
    SCATTER_PAD.top + (1 - v / 100) * (SCATTER_H - SCATTER_PAD.top - SCATTER_PAD.bottom);
  const yTicks = [0, 50, 100];

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${SCATTER_W} ${SCATTER_H}`}
        className="block h-auto w-full"
        role="img"
        aria-label={t("tasks:analyticsHub.overview.scatter.hint")}
      >
        {yTicks.map((tick) => (
          <g key={tick}>
            <line
              x1={SCATTER_PAD.left}
              x2={SCATTER_W - SCATTER_PAD.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke="var(--color-chart-grid)"
              strokeWidth={1}
            />
            <text x={SCATTER_PAD.left - 6} y={y(tick) + 3} textAnchor="end" fontSize={10} fill="currentColor" className="text-muted">
              {tick}%
            </text>
          </g>
        ))}
        {workload.map((w) => (
          <circle
            key={w.assigneeId}
            cx={x(w.assignedCount)}
            cy={y(w.completionRate)}
            r={4}
            fill="var(--color-chart-ink)"
            fillOpacity={0.75}
          >
            <title>{`${nameOf(w.assigneeId)} — ${w.assignedCount} ${t("tasks:analyticsHub.overview.scatter.xLabel")}, ${Math.round(w.completionRate)}%`}</title>
          </circle>
        ))}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-muted">
        <span>{t("tasks:analyticsHub.overview.scatter.xLabel")}</span>
        <span>{t("tasks:analyticsHub.overview.scatter.yLabel")}</span>
      </div>
    </figure>
  );
}

const DONUT_R = 40;
const DONUT_STROKE = 16;

/** The six-category status breakdown as a donut (same categories, colors and
 *  data as StatusBreakdownBar — just a different shape for the same facts). */
export function StatusDonut({ breakdown }: { breakdown: StatusBreakdownDTO }) {
  const { t } = useTranslation("tasks");
  const total = STATUS_ORDER.reduce((sum, k) => sum + breakdown[k], 0);
  const c = 2 * Math.PI * DONUT_R;
  let offset = 0;
  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 100 100" width={120} height={120} role="img" aria-label={t("tasks:analyticsHub.overview.sections.statusDistribution")}>
        <circle cx={50} cy={50} r={DONUT_R} fill="none" stroke="var(--color-chart-grid)" strokeWidth={DONUT_STROKE} />
        {total > 0 &&
          STATUS_ORDER.filter((k) => breakdown[k] > 0).map((k) => {
            const frac = breakdown[k] / total;
            const dash = frac * c;
            const dashOffset = -offset;
            offset += dash;
            return (
              <circle
                key={k}
                cx={50}
                cy={50}
                r={DONUT_R}
                fill="none"
                stroke={STATUS_COLORS[k]}
                strokeWidth={DONUT_STROKE}
                strokeDasharray={`${dash} ${c - dash}`}
                strokeDashoffset={dashOffset}
                transform="rotate(-90 50 50)"
              >
                <title>{`${t(`tasks:analytics.statuses.${k}`)}: ${breakdown[k]}`}</title>
              </circle>
            );
          })}
        <text x={50} y={54} textAnchor="middle" fontSize={16} fontWeight={600} fill="currentColor" className="text-fg">
          {total}
        </text>
      </svg>
      <dl className="grid grid-cols-1 gap-1.5 text-xs">
        {STATUS_ORDER.map((k) => (
          <div key={k} className="flex items-center gap-1.5">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: STATUS_COLORS[k] }} />
            <dt className="text-muted">{t(`tasks:analytics.statuses.${k}`)}</dt>
            <dd className="font-medium tabular-nums text-fg">
              {breakdown[k]} ({Math.round(pct(breakdown[k], total))}%)
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const PULSE_W = 560;
const PULSE_H = 190;
const PULSE_PAD = { left: 30, right: 10, top: 10, bottom: 24 };

/** Two thin lines — created vs completed — over every day in the selected
 *  range. Generalized from member/MemberAnalyticsCharts' ActivityTrendChart
 *  (fixed to 7 weekdays) to N days, with first/last/peak-only x labels
 *  (BarChart's selective-labeling rule) since a 90-day range can't label
 *  every point. */
export function ActivityPulseChart({ points }: { points: DailyActivityPointDTO[] }) {
  const { t, i18n } = useTranslation("tasks");
  if (points.length === 0) return null;
  const max = Math.max(1, ...points.flatMap((p) => [p.tasksCreated, p.tasksCompleted]));
  const x = (i: number) =>
    PULSE_PAD.left + (points.length > 1 ? (i * (PULSE_W - PULSE_PAD.left - PULSE_PAD.right)) / (points.length - 1) : 0);
  const y = (v: number) => PULSE_PAD.top + (1 - v / max) * (PULSE_H - PULSE_PAD.top - PULSE_PAD.bottom);
  const series = [
    { key: "created", label: t("tasks:analyticsHub.overview.activity.created"), color: "var(--color-chart-context)", values: points.map((p) => p.tasksCreated) },
    { key: "completed", label: t("tasks:analyticsHub.overview.activity.completed"), color: "var(--color-chart-ink)", values: points.map((p) => p.tasksCompleted) },
  ];
  const ticks = [0, 0.5, 1];
  const peakIdx = points.reduce(
    (best, p, i) => (p.tasksCreated + p.tasksCompleted > (points[best]?.tasksCreated ?? 0) + (points[best]?.tasksCompleted ?? 0) ? i : best),
    0,
  );
  const labelDay = (day: string) => {
    const [y_, m, d] = day.split("-").map(Number);
    return new Date(y_ ?? 1970, (m ?? 1) - 1, d ?? 1).toLocaleDateString(i18n.language, { day: "numeric", month: "short" });
  };

  return (
    <figure className="m-0">
      <figcaption className="mb-2 flex items-center justify-end gap-4 text-[11px] text-muted">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </figcaption>
      <svg viewBox={`0 0 ${PULSE_W} ${PULSE_H}`} className="block h-auto w-full" role="img" aria-label={t("tasks:analyticsHub.overview.activity.hint")}>
        {ticks.map((f) => (
          <g key={f}>
            <line x1={PULSE_PAD.left} x2={PULSE_W - PULSE_PAD.right} y1={y(max * f)} y2={y(max * f)} stroke="var(--color-chart-grid)" strokeWidth={1} />
            <text x={PULSE_PAD.left - 6} y={y(max * f) + 3} textAnchor="end" fontSize={10} fill="currentColor" className="text-muted">
              {Math.round(max * f)}
            </text>
          </g>
        ))}
        {points.map((p, i) =>
          i === 0 || i === points.length - 1 || i === peakIdx ? (
            <text key={p.day} x={x(i)} y={PULSE_H - 6} textAnchor="middle" fontSize={10} fill="currentColor" className="text-muted">
              {labelDay(p.day)}
            </text>
          ) : null,
        )}
        {series.map((s) => (
          <g key={s.key}>
            <path
              d={s.values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}
              fill="none"
              stroke={s.color}
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        ))}
      </svg>
    </figure>
  );
}

/** The four KPI cards, built from the same KpiTile ChannelAnalyticsPanel uses
 *  — no second "label + value in a card" implementation. */
export function OverviewKpiGrid({
  total,
  completed,
  inProgress,
  overdue,
}: {
  total: number;
  completed: number;
  inProgress: number;
  overdue: number;
}) {
  const { t } = useTranslation("tasks");
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <KpiTile label={t("tasks:analyticsHub.overview.kpis.total")} value={String(total)} />
      <KpiTile label={t("tasks:analyticsHub.overview.kpis.completed")} value={String(completed)} />
      <KpiTile label={t("tasks:analyticsHub.overview.kpis.inProgress")} value={String(inProgress)} />
      <KpiTile label={t("tasks:analyticsHub.overview.kpis.overdue")} value={String(overdue)} />
    </div>
  );
}
