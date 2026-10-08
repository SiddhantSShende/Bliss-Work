import { useUiStrings } from "../../strings";
import { domainMax, formatMs, normalize } from "./scale";

export interface RankedDatum {
  key: string;
  label: string;
  value: number;
}

/**
 * "Which sections / apps / sites, and how much" — magnitude, ranked.
 *
 * HORIZONTAL bars, because the categories have long, arbitrary names
 * ("Google Chrome", "app.slack.com") which as vertical axis labels would have to
 * be rotated or truncated. Sequential single hue, not categorical: these are
 * amounts of one thing, and giving each row its own colour would suggest they
 * are different KINDS of thing.
 *
 * Each row is directly labelled with its value, which is affordable here because
 * the list is capped — this is the case where labelling every mark is right,
 * rather than the flood the guidance warns about.
 */
export function RankedBars({
  data,
  max: maxRows = 8,
  format = formatMs,
  emptyHint,
}: {
  data: RankedDatum[];
  max?: number;
  format?: (v: number) => string;
  emptyHint?: string;
}) {
  const strings = useUiStrings();
  const rows = data.filter((d) => d.value > 0).slice(0, maxRows);
  if (rows.length === 0) {
    return <p className="py-3 text-sm text-muted">{emptyHint ?? strings.nothingRecorded}</p>;
  }
  const max = domainMax(rows.map((d) => d.value));

  return (
    <ul className="m-0 list-none space-y-1.5 p-0">
      {rows.map((d) => (
        <li key={d.key} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2">
          <span className="truncate text-sm text-fg" title={d.label}>{d.label}</span>
          <span className="h-3 w-full overflow-hidden rounded-[4px]" style={{ background: "var(--color-chart-grid)" }}>
            <span
              className="block h-full rounded-[4px]"
              style={{
                width: `${Math.max(2, normalize(d.value, max) * 100)}%`,
                background: "var(--color-chart-ink)",
              }}
            />
          </span>
          {/* Value in a text token, never the series colour — the coloured bar
              beside it already carries the identity. */}
          <span className="text-xs tabular-nums text-muted">{format(d.value)}</span>
        </li>
      ))}
    </ul>
  );
}
