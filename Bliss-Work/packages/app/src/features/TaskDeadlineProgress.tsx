import { useTranslation } from "react-i18next";

/**
 * Compact radial progress ring for a task card: how much of the time between
 * assignment and deadline has elapsed. Real data only — renders nothing
 * without both `assignedAt` and `deadlineAt`, rather than a meaningless full
 * or empty ring. Turns danger-toned once the deadline has passed unmet.
 */
export function TaskDeadlineProgress({
  assignedAt,
  deadlineAt,
  missedAt,
}: {
  assignedAt?: string | null;
  deadlineAt?: string | null;
  missedAt?: string | null;
}) {
  const { t } = useTranslation("stickies");
  if (!assignedAt || !deadlineAt) return null;
  const start = Date.parse(assignedAt);
  const end = Date.parse(deadlineAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;

  const now = missedAt ? Date.parse(missedAt) : Date.now();
  const elapsed = Math.min(1, Math.max(0, (now - start) / (end - start)));
  const overdue = !missedAt && now > end;
  const pct = Math.round((overdue ? 1 : elapsed) * 100);
  const color = missedAt || overdue ? "var(--color-danger)" : "var(--color-chart-ink)";

  const size = 32;
  const stroke = 3.5;
  const r = size / 2 - stroke;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;

  return (
    <div className="flex shrink-0 items-center gap-1.5" title={t("card.deadlineProgress", { pct })}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={t("card.deadlineProgress", { pct })}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-chart-grid)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="text-xs font-medium tabular-nums text-muted">{pct}%</span>
    </div>
  );
}
