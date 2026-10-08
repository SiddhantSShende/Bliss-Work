import { useUiStrings } from "../../strings";
import { domainMax, formatMs, normalize } from "./scale";

/** House spec: a column is never thicker than this, however wide its band. */
const MAX_BAR_PX = 24;

export interface BarDatum {
  /** Axis label under the column. */
  label: string;
  /** The value the story is about — drawn in the accent hue. */
  value: number;
  /** Optional context stacked above it, drawn in the de-emphasis gray. */
  context?: number;
  /** Full text for the tooltip; falls back to the label. */
  title?: string;
}

/**
 * Columns over time. Active time is the point; idle time is context.
 *
 * This is the EMPHASIS form, not a categorical chart: one hue for the series
 * that matters and a de-emphasis gray for the rest. A second categorical colour
 * here would imply the two are peers, when the reader's question is only ever
 * "how much did they actually work".
 *
 * Marks follow the house spec — columns capped at 24px with the band's leftover
 * left as air, a 4px rounded cap, square at the baseline, and a 2px surface gap
 * between the two stacked segments so they separate without a stroke.
 */
export function BarChart({
  data,
  height = 160,
  format = formatMs,
  contextLabel,
  valueLabel,
}: {
  data: BarDatum[];
  height?: number;
  format?: (v: number) => string;
  /** Legend text for the context segment. Omit for a single-series chart, which
   *  needs no legend — the surrounding heading already names it. */
  contextLabel?: string;
  valueLabel?: string;
}) {
  const strings = useUiStrings();
  const max = domainMax(data.map((d) => d.value + (d.context ?? 0)));
  const peak = data.reduce(
    (best, d) => (d.value > (best?.value ?? -1) ? d : best),
    undefined as BarDatum | undefined,
  );

  return (
    <figure className="m-0 w-full">
      {contextLabel && valueLabel && (
        <figcaption className="mb-2 flex items-center gap-4 text-xs text-muted">
          <Key color="var(--color-chart-ink)" label={valueLabel} />
          <Key color="var(--color-chart-context)" label={contextLabel} />
        </figcaption>
      )}
      <div
        className="flex w-full items-end gap-[2px] overflow-x-auto"
        style={{ height }}
        role="img"
        aria-label={strings.chartPeakAria(valueLabel ?? strings.chartValue, peak ? format(peak.value) : "0")}
      >
        {data.map((d) => {
          const valuePct = normalize(d.value, max) * 100;
          const contextPct = normalize(d.context ?? 0, max) * 100;
          return (
            // The BAND is flexible; the COLUMN inside it is capped and centred.
            // Letting the column fill its band is what makes a run of similar
            // days merge into one solid slab you cannot count — the leftover
            // space is not waste, it is what separates one day from the next.
            <div
              key={d.label}
              className="flex min-w-[6px] flex-1 justify-center"
              style={{ height: "100%" }}
              title={`${d.title ?? d.label}: ${
                d.context ? strings.chartActiveIdle(format(d.value), format(d.context)) : format(d.value)
              }`}
            >
              <div className="flex w-full flex-col justify-end" style={{ maxWidth: MAX_BAR_PX }}>
                {contextPct > 0 && (
                  <div
                    // 4px rounded data-end at the top of the stack, square where
                    // it meets the segment below.
                    className="w-full rounded-t-[4px]"
                    style={{
                      height: `${contextPct}%`,
                      background: "var(--color-chart-context)",
                      // The 2px surface gap: the surface doing the separating, so
                      // the two segments read apart without a border adding ink
                      // that isn't data.
                      marginBottom: valuePct > 0 ? 2 : 0,
                    }}
                  />
                )}
                <div
                  className={contextPct > 0 ? "w-full" : "w-full rounded-t-[4px]"}
                  style={{
                    height: `${Math.max(valuePct, d.value > 0 ? 1 : 0)}%`,
                    background: "var(--color-chart-ink)",
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
      {/* Labelled selectively — only the first, last and peak columns. A value
          on every column is unread noise, and the tooltip carries the rest. */}
      <div className="mt-1.5 flex w-full gap-[2px] text-[10px] text-muted">
        {data.map((d, i) => (
          <span key={d.label} className="min-w-[6px] flex-1 truncate text-center">
            {i === 0 || i === data.length - 1 || d === peak ? d.label : ""}
          </span>
        ))}
      </div>
    </figure>
  );
}

/** A colored key beside text — identity comes from the mark, never from
 *  colouring the label itself. */
function Key({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2 w-4 rounded-[2px]" style={{ background: color }} />
      {label}
    </span>
  );
}
