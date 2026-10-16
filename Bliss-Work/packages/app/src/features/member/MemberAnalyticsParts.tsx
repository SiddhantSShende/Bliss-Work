import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowRight, ArrowUp } from "lucide-react";
import { Card } from "@taskboard/ui";
import { formatMs } from "../../i18n/format";
import type { ActivitySummaryDTO, NamedCount, TimelineEntry } from "@taskboard/shared";
import { actionLabel, formatDuration } from "./activityLabels";
import { resolveAppName } from "./appNames";
import { getAppIcon } from "./appIcons";
import { ActivityStackedChart } from "./MemberAnalyticsCharts";
import { activityBuckets } from "./memberAnalyticsData";

/** One headline number: icon, label, value and a line of small supporting text,
 *  with an optional compact chart vertically centered to its right. `change` is
 *  a real % versus the previous period, or null/undefined to omit it. */
export function SummaryCard({
  icon,
  label,
  value,
  hint,
  change,
  sparkline,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  change?: number | null;
  /** A small chart (e.g. MiniSparkline) placed beside the text, centered on the
   *  card's height. Omitted when there isn't enough real data to draw one. */
  sparkline?: React.ReactNode;
}) {
  const { t } = useTranslation("members");
  return (
    <Card className="flex items-center justify-between gap-3 p-5">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex items-center gap-2 text-muted">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
            {icon}
          </span>
          <span className="text-sm font-medium">{label}</span>
        </div>
        <div className="mt-1 text-2xl font-semibold tabular-nums text-fg">{value}</div>
        {hint && <div className="text-xs text-muted">{hint}</div>}
        {change != null && change !== 0 && (
          <div className={`flex items-center gap-1 text-xs ${change > 0 ? "text-success" : "text-danger"}`}>
            {change > 0 ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
            <span className="font-medium tabular-nums">{Math.abs(change)}%</span>
            <span className="text-muted">{t("members:analytics.summary.vsPrevious")}</span>
          </div>
        )}
      </div>
      {sparkline && <div className="flex shrink-0 items-center self-center">{sparkline}</div>}
    </Card>
  );
}

/** A titled white card for one section of the dashboard. */
export function SectionCard({
  icon,
  title,
  hint,
  children,
  className = "",
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={`flex min-w-0 flex-col p-5 ${className}`}>
      <div className="mb-5 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
          {icon}
        </span>
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-fg">{title}</h4>
          {hint && <p className="text-xs text-muted">{hint}</p>}
        </div>
      </div>
      {children}
    </Card>
  );
}

/** Active vs idle for the period: headline totals, then a stacked bar chart
 *  of active/idle per time bucket (same style as Workspace Analytics' Status
 *  Flow chart) showing how that split moves across the range. */
export function ActivityOverviewBody({ data, from, to }: { data: ActivitySummaryDTO; from: string; to: string }) {
  const { t } = useTranslation("members");
  const signedIn = data.totalActiveMs + data.totalIdleMs;
  const share = signedIn > 0 ? Math.round((data.totalActiveMs / signedIn) * 100) : 0;
  const buckets = activityBuckets(data.days, from, to);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between gap-3">
        <div className="text-3xl font-semibold tabular-nums text-fg">{formatMs(data.totalActiveMs)}</div>
        <div className="text-sm tabular-nums text-muted">{signedIn > 0 ? `${share}%` : "—"}</div>
      </div>
      <ActivityStackedChart buckets={buckets} />
      <dl className="grid grid-cols-2 gap-4 border-t border-border/60 pt-4">
        <Legend color="var(--color-chart-ink)" label={t("members:analytics.overview.active")} value={formatMs(data.totalActiveMs)} />
        <Legend
          color="var(--color-chart-context)"
          label={t("members:analytics.overview.idle")}
          value={formatMs(data.totalIdleMs)}
          hint={t("members:analytics.overview.idleHint")}
        />
      </dl>
    </div>
  );
}

function Legend({ color, label, value, hint }: { color: string; label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="flex items-center gap-1.5 text-xs text-muted">
        <span className="h-2 w-2 rounded-full" style={{ background: color }} />
        {label}
      </dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums text-fg">{value}</dd>
      {hint && <p className="text-[11px] text-muted">{hint}</p>}
    </div>
  );
}

/** Most-used applications as plain horizontal bars. `apps` is the summary's
 *  `topApps`; each row is led by a real brand icon when one exists for that
 *  executable (see appIcons.ts), falling back to the neutral initial tile. */
export function TopAppsBody({ apps }: { apps: NamedCount[] }) {
  const { t } = useTranslation("members");
  const rows = apps.filter((a) => a.valueMs > 0).slice(0, 5);
  if (rows.length === 0) return <p className="text-sm text-muted">{t("members:analytics.topApps.empty")}</p>;
  const max = Math.max(...rows.map((a) => a.valueMs));
  return (
    <ul className="m-0 list-none space-y-4 p-0">
      {rows.map((a) => {
        const name = resolveAppName(a.key);
        const AppIcon = getAppIcon(a.key);
        return (
          <li key={a.key} className="flex items-center gap-3">
            {AppIcon ? (
              <span className="flex h-8 w-8 shrink-0 items-center justify-center">
                <AppIcon size={24} />
              </span>
            ) : (
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-xs font-semibold text-muted">
                {name.charAt(0).toUpperCase()}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="truncate text-fg" title={name}>{name}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted">{formatMs(a.valueMs)}</span>
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full" style={{ background: "var(--color-chart-grid)" }}>
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.max(3, (a.valueMs / max) * 100)}%`, background: "var(--color-chart-ink)" }}
                />
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** The latest rows of the member's activity timeline: time, what, how long. */
export function RecentActivityBody({
  entries,
  onViewAll,
}: {
  entries: TimelineEntry[];
  onViewAll?: () => void;
}) {
  const { t, i18n } = useTranslation("members");
  return (
    <div className="flex flex-1 flex-col justify-between gap-4">
      {entries.length === 0 ? (
        <p className="text-sm text-muted">{t("members:analytics.recent.empty")}</p>
      ) : (
        <ul className="m-0 list-none divide-y divide-border/50 p-0">
          {entries.map((e) => (
            <li key={e.id} className="flex items-center gap-3 py-2 text-sm first:pt-0">
              <time
                className="w-16 shrink-0 whitespace-nowrap text-xs tabular-nums text-muted"
                dateTime={e.occurredAt}
                title={new Date(e.occurredAt).toLocaleString(i18n.language)}
              >
                {new Date(e.occurredAt).toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" })}
              </time>
              <span className="min-w-0 flex-1 truncate text-fg">
                {e.action === "app.focus" && e.targetId ? resolveAppName(e.targetId) : actionLabel(e, t)}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted">{formatDuration(e.durationMs)}</span>
            </li>
          ))}
        </ul>
      )}
      {onViewAll && (
        <button
          type="button"
          onClick={onViewAll}
          className="inline-flex items-center gap-1 self-start text-sm font-medium text-accent hover:underline"
        >
          {t("members:analytics.recent.viewAll")}
          <ArrowRight size={14} />
        </button>
      )}
    </div>
  );
}
