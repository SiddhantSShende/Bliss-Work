import { useTranslation } from "react-i18next";
import type {
  DailyActivityPointDTO,
  KpiTrendDTO,
  ProjectPerformanceDTO,
  StatusBreakdownDTO,
  StatusDayPointDTO,
  WorkloadBreakdownDTO,
} from "@taskboard/shared";
import { StatTile } from "@taskboard/ui";

/** StatusDonut/StatusFlowChart's own vibrant, categorical status palette —
 *  deliberately NOT the shared STATUS_COLORS from TaskAnalyticsParts (which
 *  stays on its original muted mapping for every other analytics panel).
 *  completed/missed/ignored reuse the existing semantic --color-success/
 *  -danger/-muted tokens; acknowledged/sent get the two fixed
 *  --color-status-* tokens added to theme.css for this purpose (validated
 *  with the dataviz skill's palette validator for CVD separation and
 *  contrast against those three). ignored and left intentionally share the
 *  muted gray, same as STATUS_COLORS — both read as "no further action",
 *  and the legend/tooltip text still disambiguates them. */
const OVERVIEW_STATUS_COLORS: Record<keyof StatusBreakdownDTO, string> = {
  completed: "var(--color-success)",
  acknowledged: "var(--color-status-acknowledged)",
  sent: "var(--color-status-sent)",
  missed: "var(--color-danger)",
  ignored: "var(--color-muted)",
  left: "var(--color-muted)",
};
const STATUS_ORDER = Object.keys(OVERVIEW_STATUS_COLORS) as (keyof StatusBreakdownDTO)[];

function pct(n: number, d: number): number {
  return d > 0 ? (n / d) * 100 : 0;
}

/** A rounded percentage-point delta, colored by whether that direction is
 *  good for THIS metric (e.g. a rising "Overdue" is bad, a rising
 *  "Completed" is good) — shared by the KPI cards and the project ranking's
 *  trend indicator so both read the same way. */
function TrendDelta({
  deltaPct,
  goodDirection,
}: {
  deltaPct: number | null | undefined;
  goodDirection: "up" | "down";
}) {
  if (deltaPct == null) return null;
  const rounded = Math.round(deltaPct);
  const flat = rounded === 0;
  const good = !flat && (rounded > 0) === (goodDirection === "up");
  const color = flat ? "var(--color-muted)" : good ? "var(--color-success)" : "var(--color-danger)";
  const arrow = flat ? "→" : rounded > 0 ? "▲" : "▼";
  return (
    <span className="tabular-nums" style={{ color }}>
      {arrow} {Math.abs(rounded)}%
    </span>
  );
}

/** A KPI card's hint: the delta vs the immediately preceding, equal-length
 *  period, or an explicit "nothing to compare" note — never a fabricated 0%. */
function KpiTrendHint({ kpi, goodDirection }: { kpi: KpiTrendDTO; goodDirection: "up" | "down" }) {
  const { t } = useTranslation("tasks");
  if (kpi.deltaPct == null) {
    return <span>{t("tasks:analyticsHub.overview.kpis.noPreviousPeriod")}</span>;
  }
  return (
    <span className="inline-flex items-center gap-1">
      <TrendDelta deltaPct={kpi.deltaPct} goodDirection={goodDirection} />
      <span className="text-muted">{t("tasks:analyticsHub.overview.kpis.vsPreviousPeriod")}</span>
    </span>
  );
}

/** Ranked list of projects by task volume — name, completed/total, completion
 *  rate (progress bar) and a trend indicator (this project's completion rate
 *  vs the preceding period). Replaces the retired channel-wise ranking: the
 *  server now ranks real projects (tasks.projectId), never channels. */
export function ProjectPerformanceList({
  projects,
  emptyHint,
}: {
  projects: ProjectPerformanceDTO[];
  emptyHint: string;
}) {
  if (projects.length === 0) return <p className="py-3 text-sm text-muted">{emptyHint}</p>;
  return (
    <ul className="m-0 list-none space-y-3 p-0">
      {projects.map((p, i) => (
        <li key={p.projectId} className="flex items-center gap-3">
          <span className="w-4 shrink-0 text-xs tabular-nums text-muted">{i + 1}</span>
          <span className="w-24 shrink-0 truncate text-sm text-fg" title={p.name}>
            {p.name}
          </span>
          <div className="min-w-0 flex-1">
            <div
              className="h-2 w-full overflow-hidden rounded-full"
              style={{ background: "var(--color-chart-grid)" }}
            >
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(3, p.completionRate)}%`,
                  background: "var(--color-chart-ink)",
                }}
              />
            </div>
          </div>
          <span className="shrink-0 text-xs tabular-nums text-muted">
            {p.completedUniqueTasks}/{p.totalUniqueTasks} ({Math.round(p.completionRate)}%)
          </span>
          <span className="w-10 shrink-0 text-right text-[11px]">
            <TrendDelta deltaPct={p.trendPct} goodDirection="up" />
          </span>
        </li>
      ))}
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
                <td className="max-w-[9rem] truncate px-3 py-2 text-fg" title={name}>
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
const SCATTER_H = 230;
const SCATTER_PAD = { left: 34, right: 10, top: 10, bottom: 24 };

/** Assigned workload (x) against completion rate (y, fixed 0..100), one point
 *  per person — the same `workload` array WorkloadMatrixTable renders as a
 *  table, read here as a shape instead of a lookup. Quadrant dividers split
 *  at the midpoint of the visible load range (x) and the midpoint of the
 *  completion-rate domain (y = 50%) — there's no server-provided threshold,
 *  so "average load, half complete" is the deterministic, explainable split. */
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
  const innerW = SCATTER_W - SCATTER_PAD.left - SCATTER_PAD.right;
  const innerH = SCATTER_H - SCATTER_PAD.top - SCATTER_PAD.bottom;
  const x = (v: number) => SCATTER_PAD.left + (v / maxAssigned) * innerW;
  const y = (v: number) => SCATTER_PAD.top + (1 - v / 100) * innerH;
  const yTicks = [0, 50, 100];
  const xTicks = [...new Set([0, Math.round(maxAssigned / 2), maxAssigned])];
  const midX = x(maxAssigned / 2);
  const assignedLabel = t("tasks:analyticsHub.overview.scatter.xLabel");
  const completionLabel = t("tasks:analyticsHub.overview.scatter.yLabel");
  const completedLabel = t("tasks:analyticsHub.overview.workloadTable.completed");

  const midY = y(50);
  const quadrantLabelStyle = {
    fontSize: 9,
    fill: "var(--color-fg)",
    paintOrder: "stroke",
    stroke: "var(--color-surface)",
    strokeWidth: 4,
    strokeLinejoin: "round",
  } as const;
  const plotLeft = SCATTER_PAD.left;
  const plotRight = SCATTER_W - SCATTER_PAD.right;
  const plotBottom = SCATTER_H - SCATTER_PAD.bottom;
  const scatterColor = (w: WorkloadBreakdownDTO) => {
    const highLoad = w.assignedCount >= maxAssigned / 2;
    const highCompletion = w.completionRate >= 50;
    if (highLoad && highCompletion) return "var(--color-scatter-high-high)";
    if (highLoad) return "var(--color-scatter-high-low)";
    if (highCompletion) return "var(--color-scatter-low-high)";
    return "var(--color-scatter-low-low)";
  };

  return (
    <figure className="m-0">
      <div className="flex min-w-0 gap-1">
        <div className="flex w-3 shrink-0 items-center justify-center">
          <span
            className="origin-center whitespace-nowrap text-[10px] text-muted"
            style={{ transform: "rotate(-90deg)" }}
          >
            {completionLabel}
          </span>
        </div>
        <svg
          viewBox={`0 0 ${SCATTER_W} ${SCATTER_H}`}
          className="block h-auto w-full min-w-0 flex-1"
          role="img"
          aria-label={t("tasks:analyticsHub.overview.scatter.hint")}
        >
          <rect
            x={plotLeft}
            y={SCATTER_PAD.top}
            width={midX - plotLeft}
            height={midY - SCATTER_PAD.top}
            fill="var(--color-scatter-low-high)"
            fillOpacity={0.07}
          />
          <rect
            x={midX}
            y={SCATTER_PAD.top}
            width={plotRight - midX}
            height={midY - SCATTER_PAD.top}
            fill="var(--color-scatter-high-high)"
            fillOpacity={0.07}
          />
          <rect
            x={plotLeft}
            y={midY}
            width={midX - plotLeft}
            height={plotBottom - midY}
            fill="var(--color-scatter-low-low)"
            fillOpacity={0.07}
          />
          <rect
            x={midX}
            y={midY}
            width={plotRight - midX}
            height={plotBottom - midY}
            fill="var(--color-scatter-high-low)"
            fillOpacity={0.07}
          />
          {yTicks.map((tick) => (
            <g key={`y${tick}`}>
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
          {xTicks.map((tick) => (
            <text
              key={`x${tick}`}
              x={x(tick)}
              y={SCATTER_H - SCATTER_PAD.bottom + 16}
              textAnchor="middle"
              fontSize={10}
              fill="currentColor"
              className="text-muted"
            >
              {tick}
            </text>
          ))}
          <line
            x1={midX}
            x2={midX}
            y1={SCATTER_PAD.top}
            y2={plotBottom}
            stroke="var(--color-muted)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
          <line
            x1={plotLeft}
            x2={plotRight}
            y1={midY}
            y2={midY}
            stroke="var(--color-muted)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
          <g pointerEvents="none">
            <text x={midX / 2 + plotLeft / 2} y={SCATTER_PAD.top + 14} textAnchor="middle" {...quadrantLabelStyle}>
              {t("tasks:analyticsHub.overview.scatter.quadrants.highEffLowLoad")}
            </text>
            <text x={(midX + plotRight) / 2} y={SCATTER_PAD.top + 14} textAnchor="middle" {...quadrantLabelStyle}>
              {t("tasks:analyticsHub.overview.scatter.quadrants.highEffHighLoad")}
            </text>
            <text x={midX / 2 + plotLeft / 2} y={plotBottom - 7} textAnchor="middle" {...quadrantLabelStyle}>
              {t("tasks:analyticsHub.overview.scatter.quadrants.lowEffLowLoad")}
            </text>
            <text x={(midX + plotRight) / 2} y={plotBottom - 7} textAnchor="middle" {...quadrantLabelStyle}>
              {t("tasks:analyticsHub.overview.scatter.quadrants.lowEffHighLoad")}
            </text>
          </g>
          {workload.map((w) => (
            <circle
              key={w.assigneeId}
              cx={x(w.assignedCount)}
              cy={y(w.completionRate)}
              r={4.5}
              fill={scatterColor(w)}
              fillOpacity={0.85}
              stroke="var(--color-surface)"
              strokeWidth={1.5}
            >
              <title>{`${nameOf(w.assigneeId)} — ${assignedLabel}: ${w.assignedCount}, ${completedLabel}: ${w.completedCount}, ${completionLabel}: ${Math.round(w.completionRate)}%`}</title>
            </circle>
          ))}
        </svg>
      </div>
      <div className="mt-1 text-center text-[10px] text-muted">{assignedLabel}</div>
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
    <div className="flex min-w-0 items-center justify-center gap-3 sm:gap-4">
      <svg
        viewBox="0 0 100 100"
        className="aspect-square w-[38%] min-w-24 max-w-48 shrink-0"
        role="img"
        aria-label={t("tasks:analyticsHub.overview.sections.statusDistribution")}
      >
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
                stroke={OVERVIEW_STATUS_COLORS[k]}
                strokeWidth={DONUT_STROKE}
                strokeDasharray={`${dash} ${c - dash}`}
                strokeDashoffset={dashOffset}
                transform="rotate(-90 50 50)"
              >
                <title>{`${t(`tasks:analytics.statuses.${k}`)}: ${breakdown[k]}`}</title>
              </circle>
            );
          })}
        <text x={50} y={47} textAnchor="middle" fontSize={20} fontWeight={700} fill="currentColor" className="text-fg">
          {total}
        </text>
        <text x={50} y={59} textAnchor="middle" fontSize={8} fill="currentColor" className="text-muted">
          {t("tasks:analyticsHub.overview.donutTotalLabel")}
        </text>
      </svg>
      <dl className="flex min-w-0 flex-1 flex-col gap-1.5 text-xs">
        {STATUS_ORDER.map((k) => (
          <div key={k} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2">
            <dt className="flex min-w-0 items-center gap-1.5">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: OVERVIEW_STATUS_COLORS[k] }} />
              <span className="truncate text-muted">{t(`tasks:analytics.statuses.${k}`)}</span>
            </dt>
            <dd className="whitespace-nowrap text-right font-medium tabular-nums text-fg">
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

/** The four KPI cards — headline value, a sparkline of real daily event
 *  counts, and a colored delta against the preceding period. Built on the
 *  shared StatTile/Sparkline (packages/ui) rather than TaskAnalyticsParts'
 *  plain KpiTile, since this is the one place in the app a KPI needs a trend
 *  line; ChannelAnalyticsPanel/ProjectAnalyticsPanel keep using KpiTile. */
export function OverviewKpiGrid({
  totalTasks,
  completed,
  inProgress,
  overdue,
}: {
  totalTasks: KpiTrendDTO;
  completed: KpiTrendDTO;
  inProgress: KpiTrendDTO;
  overdue: KpiTrendDTO;
}) {
  const { t } = useTranslation("tasks");
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile
        label={t("tasks:analyticsHub.overview.kpis.total")}
        value={String(totalTasks.value)}
        trend={totalTasks.sparkline}
        trendPlacement="right"
        hint={<KpiTrendHint kpi={totalTasks} goodDirection="up" />}
      />
      <StatTile
        label={t("tasks:analyticsHub.overview.kpis.completed")}
        value={String(completed.value)}
        trend={completed.sparkline}
        trendPlacement="right"
        hint={<KpiTrendHint kpi={completed} goodDirection="up" />}
      />
      <StatTile
        label={t("tasks:analyticsHub.overview.kpis.inProgress")}
        value={String(inProgress.value)}
        trend={inProgress.sparkline}
        trendPlacement="right"
        hint={<KpiTrendHint kpi={inProgress} goodDirection="up" />}
      />
      <StatTile
        label={t("tasks:analyticsHub.overview.kpis.overdue")}
        value={String(overdue.value)}
        trend={overdue.sparkline}
        trendPlacement="right"
        hint={<KpiTrendHint kpi={overdue} goodDirection="down" />}
      />
    </div>
  );
}

const FLOW_W = 560;
const FLOW_H = 190;
const FLOW_PAD = { left: 30, right: 10, top: 10, bottom: 24 };

/** A stacked timeline of the six status categories, one bar per day — the
 *  over-time counterpart to StatusDonut's single-snapshot totals. Each bar
 *  segment is a count of assignee rows that ENTERED that status that day
 *  (see StatusDayPointDTO), reusing the exact OVERVIEW_STATUS_COLORS
 *  StatusDonut keys off, so the two charts read as one palette. */
export function StatusFlowChart({ points }: { points: StatusDayPointDTO[] }) {
  const { t, i18n } = useTranslation("tasks");
  if (points.length === 0) return null;
  const totals = points.map((p) => STATUS_ORDER.reduce((sum, k) => sum + p[k], 0));
  const max = Math.max(1, ...totals);
  const innerW = FLOW_W - FLOW_PAD.left - FLOW_PAD.right;
  const innerH = FLOW_H - FLOW_PAD.top - FLOW_PAD.bottom;
  const slot = innerW / points.length;
  const barW = Math.max(1, slot - 2);
  const x = (i: number) => FLOW_PAD.left + i * slot;
  const y = (v: number) => FLOW_PAD.top + (1 - v / max) * innerH;
  const yTicks = [0, 0.5, 1];
  const peakIdx = totals.reduce((best, v, i) => (v > (totals[best] ?? 0) ? i : best), 0);
  const labelDay = (day: string) => {
    const [y_, m, d] = day.split("-").map(Number);
    return new Date(y_ ?? 1970, (m ?? 1) - 1, d ?? 1).toLocaleDateString(i18n.language, {
      day: "numeric",
      month: "short",
    });
  };

  return (
    <figure className="m-0">
      <figcaption className="mb-2 flex flex-wrap items-center justify-end gap-3 text-[11px] text-muted">
        {STATUS_ORDER.map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: OVERVIEW_STATUS_COLORS[k] }} />
            {t(`tasks:analytics.statuses.${k}`)}
          </span>
        ))}
      </figcaption>
      <svg
        viewBox={`0 0 ${FLOW_W} ${FLOW_H}`}
        className="block h-auto w-full"
        role="img"
        aria-label={t("tasks:analyticsHub.overview.sections.statusFlow")}
      >
        {yTicks.map((f) => (
          <g key={f}>
            <line
              x1={FLOW_PAD.left}
              x2={FLOW_W - FLOW_PAD.right}
              y1={y(max * f)}
              y2={y(max * f)}
              stroke="var(--color-chart-grid)"
              strokeWidth={1}
            />
            <text
              x={FLOW_PAD.left - 6}
              y={y(max * f) + 3}
              textAnchor="end"
              fontSize={10}
              fill="currentColor"
              className="text-muted"
            >
              {Math.round(max * f)}
            </text>
          </g>
        ))}
        {points.map((p, i) => {
          let cursor = FLOW_PAD.top + innerH;
          return (
            <g key={p.day}>
              {STATUS_ORDER.filter((k) => p[k] > 0).map((k) => {
                // A 1.5px floor keeps a real-but-tiny count visible instead of
                // vanishing to a sub-pixel sliver; the 1px drawn gap (height
                // trimmed, not the stacking math) separates adjacent segments
                // without changing their relative order or proportions.
                const h = Math.max((p[k] / max) * innerH, 1.5);
                cursor -= h;
                return (
                  <rect key={k} x={x(i)} y={cursor + 0.5} width={barW} height={Math.max(h - 1, 0.5)} fill={OVERVIEW_STATUS_COLORS[k]}>
                    <title>{`${labelDay(p.day)} — ${t(`tasks:analytics.statuses.${k}`)}: ${p[k]}`}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}
        {points.map((p, i) =>
          i === 0 || i === points.length - 1 || i === peakIdx ? (
            <text
              key={p.day}
              x={x(i) + barW / 2}
              y={FLOW_H - 6}
              textAnchor="middle"
              fontSize={10}
              fill="currentColor"
              className="text-muted"
            >
              {labelDay(p.day)}
            </text>
          ) : null,
        )}
      </svg>
    </figure>
  );
}
