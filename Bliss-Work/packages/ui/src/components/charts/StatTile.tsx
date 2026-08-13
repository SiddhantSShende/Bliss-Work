import { linePath } from "./scale";

/**
 * A single headline number, optionally with a trend.
 *
 * The form heuristic is explicit that a lone current value is a stat tile, not a
 * one-bar bar chart — "3h 40m active today" is a number, and drawing it as a
 * chart adds axes and gridlines around a single fact.
 */
export function StatTile({
  label,
  value,
  hint,
  trend,
}: {
  label: string;
  value: string;
  hint?: string;
  /** Up to ~12 points. Drawn in the de-emphasis hue: it is context for the
   *  number, not a second thing to read. */
  trend?: number[];
}) {
  return (
    <div className="rounded-xl border border-border/60 p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums text-fg">{value}</div>
      {hint && <div className="text-[11px] text-muted">{hint}</div>}
      {trend && trend.length > 1 && <Sparkline values={trend} />}
    </div>
  );
}

/** 2px line, round caps, no axes — a shape, not a chart. */
export function Sparkline({
  values,
  width = 96,
  height = 24,
}: {
  values: number[];
  width?: number;
  height?: number;
}) {
  const path = linePath(values, width, height - 2);
  if (!path) return null;
  return (
    <svg
      className="mt-1.5 block"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      // Decorative: the number above is the fact, this is its shape. A screen
      // reader announcing 12 unlabelled points would be noise.
      aria-hidden="true"
      focusable="false"
    >
      <g transform="translate(0,1)">
        <path
          d={path}
          fill="none"
          stroke="var(--color-chart-ink)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}
