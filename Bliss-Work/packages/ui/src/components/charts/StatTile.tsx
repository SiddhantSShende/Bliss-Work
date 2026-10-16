import type { ReactNode } from "react";
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
  trendPlacement = "below",
}: {
  label: string;
  value: string;
  /** Plain text, or a small node (e.g. a colored vs-previous-period delta) —
   *  widened from `string` so callers can color part of the hint without a
   *  second component. */
  hint?: ReactNode;
  /** Place a trend sparkline beside the text for compact KPI grids. */
  trendPlacement?: "below" | "right";
  /** Up to ~12 points. Drawn in the de-emphasis hue: it is context for the
   *  number, not a second thing to read. */
  trend?: number[];
}) {
  const hasTrend = Boolean(trend && trend.length > 1);
  return (
    <div className="h-full rounded-xl border border-border/60 p-3">
      <div
        className={
          trendPlacement === "right" && hasTrend
            ? "flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between lg:gap-3"
            : undefined
        }
      >
        <div className={trendPlacement === "right" && hasTrend ? "min-w-0 flex-1" : undefined}>
          <div className="text-xs text-muted">{label}</div>
          <div className="mt-0.5 text-xl font-semibold tabular-nums text-fg">{value}</div>
          {hint && <div className="text-[11px] text-muted">{hint}</div>}
        </div>
        {hasTrend && trend && (
          <Sparkline
            values={trend}
            width={84}
            className={trendPlacement === "right" ? "m-0 shrink-0 self-center" : "mt-1.5"}
          />
        )}
      </div>
    </div>
  );
}

/** 2px line, round caps, no axes — a shape, not a chart. */
export function Sparkline({
  values,
  width = 96,
  height = 24,
  className = "mt-1.5",
}: {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  const path = linePath(values, width, height - 2);
  if (!path) return null;
  return (
    <svg
      className={`block ${className}`}
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
