/**
 * Pill tabs.
 *
 * The same rounded-full pill had been open-coded three times (ChannelsList's
 * `TabButton`, ExportTasksDialog's `Chip`, the Tasks page's NavLinks) before the
 * member detail wanted a fourth. They are all the same control; this is it.
 *
 * State-driven, not route-driven — the member tabs live inside one route so a
 * tab switch does not push history the back button then has to unwind.
 */
export interface TabSpec<K extends string> {
  key: K;
  label: string;
  /** Optional icon rendered before the label (e.g. a 13px lucide icon). */
  icon?: React.ReactNode;
  /** Optional count rendered as a trailing pill (omit for none). */
  badge?: number;
}

export function Tabs<K extends string>({
  tabs,
  active,
  onChange,
  className = "",
  size = "md",
}: {
  tabs: readonly TabSpec<K>[];
  active: K;
  onChange: (key: K) => void;
  className?: string;
  /** "sm" is the compact pill used in tight chrome like a sidebar header;
   *  defaults to "md", the size every other consumer uses. */
  size?: "sm" | "md";
}) {
  const tabGap = size === "sm" ? "gap-1" : "gap-1.5";
  const pillClasses =
    size === "sm" ? "gap-1 px-3 py-1 text-[11px]" : "gap-1.5 px-3 py-1.5 text-sm";
  return (
    // Horizontally scrollable so a narrow window scrolls the tab strip rather
    // than wrapping it into a second row that shifts the panel below.
    <div
      role="tablist"
      className={`flex ${tabGap} overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${className}`}
    >
      {tabs.map((t) => {
        const on = t.key === active;
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.key)}
            className={`inline-flex shrink-0 items-center rounded-full font-medium transition-colors ${pillClasses} ${
              on ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted hover:text-fg"
            }`}
          >
            {t.icon}
            {t.label}
            {t.badge != null && (
              <span className={`text-xs ${on ? "opacity-80" : "opacity-70"}`}>{t.badge}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
