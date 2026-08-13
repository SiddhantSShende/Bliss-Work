/**
 * The six lines of maths a chart actually needs.
 *
 * Not a scale library. Every chart here is a bar, a sparkline or a grid over a
 * linear domain, and d3-scale would be ~90KB gzipped of dependency to compute
 * `(v / max) * height`. The bundle matters: this repo lazy-imports exceljs
 * specifically to keep the initial payload small, and the analytics view is a
 * primary screen where a loading spinner for a charting library would be felt.
 */

/** Value → 0..1 against a domain maximum. Guards the empty-data case, where a
 *  zero max would otherwise produce NaN and silently render nothing. */
export function normalize(value: number, max: number): number {
  if (!Number.isFinite(value) || max <= 0) return 0;
  return Math.min(1, Math.max(0, value / max));
}

/** The domain maximum, with a floor so an all-zero series still draws an axis
 *  rather than collapsing. */
export function domainMax(values: number[]): number {
  const max = values.reduce((m, v) => (Number.isFinite(v) && v > m ? v : m), 0);
  return max > 0 ? max : 1;
}

/**
 * Bucket a value into a sequential ramp of `steps` colours.
 *
 * Zero always maps to bucket 0 — "nothing happened" must read as the lightest
 * step and not be rounded up into looking like activity.
 */
export function rampIndex(value: number, max: number, steps: number): number {
  if (value <= 0 || max <= 0) return 0;
  const idx = Math.ceil((value / max) * (steps - 1));
  return Math.min(steps - 1, Math.max(1, idx));
}

/** Milliseconds → a short human duration for axis ticks and labels. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = mins / 60;
  return hours < 10 ? `${hours.toFixed(1).replace(/\.0$/, "")}h` : `${Math.round(hours)}h`;
}

/** An SVG path through evenly spaced points, for a sparkline. */
export function linePath(values: number[], width: number, height: number): string {
  if (values.length === 0) return "";
  const max = domainMax(values);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  return values
    .map((v, i) => {
      const x = i * step;
      const y = height - normalize(v, max) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}
