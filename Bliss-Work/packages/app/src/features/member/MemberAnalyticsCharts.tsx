import { useTranslation } from "react-i18next";
import { useTheme } from "@taskboard/ui";
import { formatMs } from "../../i18n/format";
import type { WeekdayPoint } from "./memberAnalyticsData";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** Working-day hours the heatmap shows: 9 AM through 6 PM. */
const HEAT_HOURS = Array.from({ length: 10 }, (_, i) => i + 9);
/** Light themes: the theme's own sequential ramp (light → dark = low → high),
 *  the same tokens the shared Heatmap uses. */
const LIGHT_RAMP = [0, 1, 2, 3, 4, 5].map((n) => `var(--color-heat-${n})`);
/** Dark themes: the shared tokens run dark → light there, which would read as
 *  "lighter means more" under this card's "darker means more activity" subtitle.
 *  So the order is flipped here — pale and muted for little activity, deep and
 *  saturated for the most — keeping each theme family's hue by taking it from
 *  its own `--color-heat-4`. Lightness/chroma pairs, step 0 → 5. */
const DARK_RAMP = [
  [0.58, 0.12], [0.52, 0.35], [0.46, 0.6], [0.4, 0.85], [0.34, 1.05], [0.29, 1.2],
].map(([l, c]) => `oklch(from var(--color-heat-4) ${l} calc(c * ${c}) h)`);

/** Zero is always the lightest step; any activity is at least step 1. */
function rampStep(ms: number, max: number): number {
  const top = LIGHT_RAMP.length - 1;
  if (ms <= 0 || max <= 0) return 0;
  return Math.min(top, Math.max(1, Math.ceil((ms / max) * top)));
}

/**
 * Weekday × working-hours grid of active time, from the summary's 7×24 `hourly`
 * grid (Monday first, in the server's rollup timezone). Only 9 AM–6 PM is drawn;
 * whatever fell outside that window is summed in the caption instead of being
 * silently dropped.
 */
export function WorkHeatmap({ grid }: { grid: number[][] }) {
  const { t, i18n } = useTranslation("members");
  const ramp = useTheme().isDark ? DARK_RAMP : LIGHT_RAMP;
  const cell = (d: number, h: number) => grid[d]?.[h] ?? 0;
  const max = Math.max(0, ...WEEKDAYS.flatMap((_, d) => HEAT_HOURS.map((h) => cell(d, h))));
  const total = grid.flat().reduce((sum, v) => sum + v, 0);
  const shown = WEEKDAYS.reduce((sum, _, d) => sum + HEAT_HOURS.reduce((s, h) => s + cell(d, h), 0), 0);
  const hourLabel = (h: number) =>
    new Date(2000, 0, 1, h).toLocaleTimeString(i18n.language, { hour: "numeric" });

  return (
    <figure className="m-0">
      <div className="overflow-x-auto">
        <div
          className="grid min-w-[420px] gap-1"
          style={{ gridTemplateColumns: `2.25rem repeat(${HEAT_HOURS.length}, minmax(0, 1fr))` }}
          role="table"
          aria-label={t("members:analytics.work.hint")}
        >
          <span />
          {HEAT_HOURS.map((h) => (
            <span key={h} role="columnheader" className="text-center text-[10px] text-muted">
              {hourLabel(h)}
            </span>
          ))}
          {WEEKDAYS.map((day, d) => (
            <div key={day} className="contents" role="row">
              <span role="rowheader" className="self-center text-[11px] text-muted">{day}</span>
              {HEAT_HOURS.map((h) => (
                <span
                  key={h}
                  role="cell"
                  className="h-6 rounded-md"
                  style={{ background: ramp[rampStep(cell(d, h), max)] }}
                  title={`${day} ${hourLabel(h)} — ${formatMs(cell(d, h))}`}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <figcaption className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted">
        <span className="flex items-center gap-1.5">
          {t("members:analytics.work.less")}
          {ramp.map((c) => (
            <span key={c} className="h-2.5 w-4 rounded-[3px]" style={{ background: c }} />
          ))}
          {t("members:analytics.work.more")}
        </span>
        {total > shown && (
          <span>{t("members:analytics.work.outsideHours", { time: formatMs(total - shown) })}</span>
        )}
      </figcaption>
    </figure>
  );
}

const W = 560;
const H = 190;
const PAD = { left: 34, right: 10, top: 10, bottom: 24 };

/** Two thin lines — Active and Idle — over the seven weekdays. */
export function ActivityTrendChart({ points }: { points: WeekdayPoint[] }) {
  const { t } = useTranslation("members");
  const max = Math.max(1, ...points.flatMap((p) => [p.active, p.idle]));
  const x = (i: number) => PAD.left + (i * (W - PAD.left - PAD.right)) / (points.length - 1);
  const y = (v: number) => PAD.top + (1 - v / max) * (H - PAD.top - PAD.bottom);
  const series = [
    { key: "active", label: t("members:analytics.trend.active"), color: "var(--color-chart-ink)", values: points.map((p) => p.active) },
    { key: "idle", label: t("members:analytics.trend.idle"), color: "var(--color-chart-context)", values: points.map((p) => p.idle) },
  ];
  const ticks = [0, 0.5, 1];

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
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={t("members:analytics.trend.hint")}>
        {ticks.map((f) => (
          <g key={f}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(max * f)} y2={y(max * f)} stroke="var(--color-chart-grid)" strokeWidth={1} />
            <text x={PAD.left - 6} y={y(max * f) + 3} textAnchor="end" fontSize={10} fill="currentColor" className="text-muted">
              {formatMs(max * f)}
            </text>
          </g>
        ))}
        {WEEKDAYS.map((day, i) => (
          <text key={day} x={x(i)} y={H - 6} textAnchor="middle" fontSize={10} fill="currentColor" className="text-muted">
            {day}
          </text>
        ))}
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
            {s.values.map((v, i) => (
              <circle key={WEEKDAYS[i]} cx={x(i)} cy={y(v)} r={2.5} fill={s.color}>
                <title>{`${WEEKDAYS[i]} · ${s.label}: ${formatMs(v)}`}</title>
              </circle>
            ))}
          </g>
        ))}
      </svg>
    </figure>
  );
}
