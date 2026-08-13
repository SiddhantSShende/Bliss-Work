import { domainMax, formatMs, rampIndex } from "./scale";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const RAMP = [
  "var(--color-heat-0)",
  "var(--color-heat-1)",
  "var(--color-heat-2)",
  "var(--color-heat-3)",
  "var(--color-heat-4)",
  "var(--color-heat-5)",
];

/**
 * Day × hour grid of active time — "when does this person actually work".
 *
 * Sequential encoding, one hue, light→dark = low→high. This is the safe default
 * the form heuristic asks for when the job is "compare magnitude across a grid":
 * a rainbow here would imply the hours are different KINDS of thing rather than
 * different amounts of one thing.
 *
 * Zero always renders as step 0, never rounded up — an hour with no activity has
 * to look like nothing happened.
 */
export function Heatmap({
  /** 7 rows (Monday first) x 24 columns of milliseconds. */
  grid,
  label = "Active time by day and hour",
}: {
  grid: number[][];
  label?: string;
}) {
  const max = domainMax(grid.flat());
  const hasData = grid.some((row) => row.some((v) => v > 0));

  return (
    <figure className="m-0">
      <div className="overflow-x-auto">
        <table className="border-separate border-spacing-[2px] text-[10px]">
          <caption className="sr-only">{label}</caption>
          <thead>
            <tr>
              <th className="w-8" />
              {Array.from({ length: 24 }, (_, h) => (
                <th key={h} scope="col" className="w-4 font-normal text-muted">
                  {/* Every third hour only — 24 labels in a row is a smear. */}
                  {h % 3 === 0 ? h : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DAYS.map((day, d) => (
              <tr key={day}>
                <th scope="row" className="pr-1 text-right font-normal text-muted">{day}</th>
                {Array.from({ length: 24 }, (_, h) => {
                  const ms = grid[d]?.[h] ?? 0;
                  return (
                    <td
                      key={h}
                      className="h-4 w-4 rounded-[3px]"
                      style={{ background: RAMP[rampIndex(ms, max, RAMP.length)] }}
                      title={`${day} ${String(h).padStart(2, "0")}:00 — ${formatMs(ms)}`}
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasData && (
        <figcaption className="mt-2 flex items-center gap-1.5 text-[10px] text-muted">
          <span>Less</span>
          {RAMP.map((c) => (
            <span key={c} className="h-3 w-3 rounded-[2px]" style={{ background: c }} />
          ))}
          <span>More · up to {formatMs(max)}</span>
        </figcaption>
      )}
    </figure>
  );
}
