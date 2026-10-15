import { useTranslation } from "react-i18next";
import { Button, GlassCard } from "@taskboard/ui";
import { STATUS_FILTERS, isFiltering, NO_SENT_FILTER, type ChannelMembers, type SentTaskFilter } from "../lib/sentTaskFilter";
import { TaskFilterAssignPanel } from "./TaskFilterAssignPanel";

/** Toggle `value` in an immutable set. */
function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

/**
 * The upper-left panel of My tasks: status chips, then a People / Channels
 * picker — the same searchable, server-paged, checkbox-list pattern as the
 * New Task dialog's "Assign to" panel (see `TaskFilterAssignPanel`). The list
 * owns its own scroll area so a large org never stretches the page.
 * Filtering itself is the board's `filter` state; this only edits it.
 */
export function MyTasksFilters({
  filter,
  onChange,
  channels = [],
  channelMembers,
  onRetryChannel,
}: {
  filter: SentTaskFilter;
  onChange: (next: SentTaskFilter) => void;
  /** Used only to name a ticked channel whose members failed to load — the
   *  picker itself fetches and searches channels on its own. */
  channels?: readonly { id: string; name: string }[];
  /** What is loaded of the ticked channels' members; their people show as ticked in
   *  the People list without ever entering `filter.personIds`. */
  channelMembers?: ChannelMembers;
  /** Re-request a ticked channel's members after they failed to load. */
  onRetryChannel?: (channelId: string) => void;
}) {
  const { t } = useTranslation("tasks");

  return (
    <GlassCard className="flex min-w-0 flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-fg">{t("myTasksBoard.filters.title")}</h2>
        {isFiltering(filter) && (
          <Button variant="ghost" size="sm" onClick={() => onChange(NO_SENT_FILTER)}>
            {t("myTasksBoard.filters.clear")}
          </Button>
        )}
      </div>

      <section>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{t("myTasksBoard.filters.statusHeading")}</div>
        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((s) => {
            const on = filter.statuses.has(s);
            return (
              <button
                key={s}
                type="button"
                aria-pressed={on}
                onClick={() => onChange({ ...filter, statuses: toggled(filter.statuses, s) })}
                className={`rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors ${
                  on
                    ? "bg-gradient-to-br from-brand-from via-brand-mid to-brand-to text-accent-fg"
                    : "bg-surface-2 text-fg hover:bg-surface-2/70"
                }`}
              >
                {s.toLowerCase()}
              </button>
            );
          })}
        </div>
      </section>

      <TaskFilterAssignPanel
        filter={filter}
        channelMembers={channelMembers}
        onTogglePerson={(id) => onChange({ ...filter, personIds: toggled(filter.personIds, id) })}
        onToggleChannel={(id) => onChange({ ...filter, channelIds: toggled(filter.channelIds, id) })}
      />

      {/* A ticked channel whose members failed to load still filters (to nothing), so say
          so here instead of leaving an empty list unexplained. */}
      {channels.filter((c) => filter.channelIds.has(c.id) && channelMembers?.get(c.id) === null).map((c) => (
        <p key={c.id} role="status" className="flex flex-wrap items-center gap-x-2 text-xs text-danger">
          {t("myTasksBoard.filters.channelFailed", { name: c.name })}
          {onRetryChannel && (
            <button type="button" onClick={() => onRetryChannel(c.id)} className="font-medium underline underline-offset-2 hover:no-underline">
              {t("myTasksBoard.filters.channelRetry")}
            </button>
          )}
        </p>
      ))}
    </GlassCard>
  );
}
