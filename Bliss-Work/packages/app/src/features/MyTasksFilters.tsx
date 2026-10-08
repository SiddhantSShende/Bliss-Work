import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Search, X } from "lucide-react";
import { Avatar, Button, GlassCard } from "@taskboard/ui";
import { STATUS_FILTERS, channelMemberIds, isFiltering, NO_SENT_FILTER, type ChannelMembers, type PersonOption, type SentTaskFilter } from "../lib/sentTaskFilter";

/** Selected people shown as chips before the rest fold into a "+N" button. */
const CHIP_LIMIT = 3;

/**
 * One row of a filter list: a circular tick, then `children`. The real checkbox is
 * visually hidden but stays the control — keyboard focus, checked state, the name
 * from the row's text and the whole-row click all come from it; the circle is its
 * drawing, and shows focus through `peer-focus-visible`. `via` marks a row that is
 * ticked only because of a selected channel: same tick, a little softer, and named as
 * such through `title` and the checkbox's description.
 */
function PickRow({ on, onToggle, via, children }: { on: boolean; onToggle: () => void; via?: string; children: React.ReactNode }) {
  const noteId = useId();
  return (
    <label title={via} className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition-colors ${on ? "bg-accent-soft/60" : "hover:bg-surface-2"}`}>
      <input type="checkbox" checked={on} onChange={onToggle} aria-describedby={via ? noteId : undefined} className="peer sr-only" />
      {/* `hidden`: read as the description, but not part of the label that names the checkbox. */}
      {via && <span id={noteId} hidden>{via}</span>}
      <span
        aria-hidden
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-accent-fg transition-colors peer-checked:border-accent peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent/55 ${via ? "opacity-60" : ""}`}
      >
        {on && <Check size={11} strokeWidth={3} />}
      </span>
      {children}
    </label>
  );
}

/** Toggle `value` in an immutable set. */
function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

/**
 * The upper-left panel of My tasks: status chips, then a multi-select People
 * filter. The list owns its own scroll area so a large org never stretches the
 * page. Filtering itself is the board's `filter` state; this only edits it.
 */
export function MyTasksFilters({
  filter,
  onChange,
  people,
  nameOf,
  avatarUrlOf,
  channels = [],
  channelMembers,
  onRetryChannel,
}: {
  filter: SentTaskFilter;
  onChange: (next: SentTaskFilter) => void;
  people: readonly PersonOption[];
  nameOf: (id: string, fallback?: string) => string;
  avatarUrlOf: (id: string) => string | null | undefined;
  /** The channels the user can pick; picking one selects all of its members. */
  channels?: readonly { id: string; name: string }[];
  /** What is loaded of the ticked channels' members; their people show as ticked in
   *  the People list without ever entering `filter.personIds`. */
  channelMembers?: ChannelMembers;
  /** Re-request a ticked channel's members after they failed to load. */
  onRetryChannel?: (channelId: string) => void;
}) {
  const { t } = useTranslation("tasks");
  const [query, setQuery] = useState("");
  const [allChips, setAllChips] = useState(false);
  const [channelQuery, setChannelQuery] = useState("");

  const named = useMemo(() => people.map((p) => ({ id: p.id, name: nameOf(p.id, p.username) })), [people, nameOf]);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? named.filter((p) => p.name.toLowerCase().includes(needle)) : named;
  }, [named, query]);
  const viaChannel = useMemo(() => channelMemberIds(filter, channelMembers ?? new Map()), [filter, channelMembers]);
  const selected = named.filter((p) => filter.personIds.has(p.id));
  const chips = allChips ? selected : selected.slice(0, CHIP_LIMIT);
  const hidden = selected.length - chips.length;
  const togglePerson = (id: string) => onChange({ ...filter, personIds: toggled(filter.personIds, id) });
  const toggleChannel = (id: string) => onChange({ ...filter, channelIds: toggled(filter.channelIds, id) });
  const shownChannels = useMemo(() => {
    const needle = channelQuery.trim().toLowerCase();
    return needle ? channels.filter((c) => c.name.toLowerCase().includes(needle)) : channels;
  }, [channels, channelQuery]);

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
                  on ? "bg-accent text-accent-fg" : "bg-surface-2 text-fg hover:bg-surface-2/70"
                }`}
              >
                {s.toLowerCase()}
              </button>
            );
          })}
        </div>
      </section>

      <section className="flex min-h-0 min-w-0 flex-col gap-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">{t("myTasksBoard.filters.peopleHeading")}</div>
        <label className="relative block">
          <Search size={15} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("myTasksBoard.filters.searchPeople")}
            aria-label={t("myTasksBoard.filters.searchPeople")}
            className="h-9 w-full rounded-xl border border-border bg-surface pl-9 pr-3 text-sm text-fg placeholder:text-muted/70 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
          />
        </label>

        {selected.length > 0 && (
          <ul className="flex flex-wrap items-center gap-1.5" aria-label={t("myTasksBoard.filters.selectedPeople")}>
            {chips.map((p) => (
              <li key={p.id} className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-accent-soft py-0.5 pl-0.5 pr-1.5 text-xs font-medium text-accent">
                <Avatar name={p.name} src={avatarUrlOf(p.id)} size="sm" />
                <span className="max-w-32 truncate">{p.name}</span>
                <button
                  type="button"
                  aria-label={t("myTasksBoard.filters.removePerson", { name: p.name })}
                  onClick={() => togglePerson(p.id)}
                  className="rounded-full p-0.5 hover:bg-accent/15"
                >
                  <X size={12} />
                </button>
              </li>
            ))}
            {(hidden > 0 || allChips) && selected.length > CHIP_LIMIT && (
              <li>
                <button
                  type="button"
                  aria-expanded={allChips}
                  onClick={() => setAllChips(!allChips)}
                  className="rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium text-fg hover:bg-surface-2/70"
                >
                  {allChips ? t("myTasksBoard.filters.showFewer") : `+${hidden}`}
                </button>
              </li>
            )}
          </ul>
        )}

        <ul className="max-h-48 min-h-0 overflow-y-auto rounded-xl border border-border/60 bg-surface/60 p-1">
          {shown.map((p) => {
            const explicit = filter.personIds.has(p.id);
            const derived = !explicit && viaChannel.has(p.id);
            return (
              <li key={p.id}>
                <PickRow on={explicit || derived} onToggle={() => togglePerson(p.id)} via={derived ? t("myTasksBoard.filters.viaChannel") : undefined}>
                  {/* Initials would otherwise become part of the checkbox's name. */}
                  <span aria-hidden className="inline-flex"><Avatar name={p.name} src={avatarUrlOf(p.id)} size="sm" /></span>
                  <span className="min-w-0 flex-1 truncate text-fg">{p.name}</span>
                </PickRow>
              </li>
            );
          })}
          {shown.length === 0 && <li className="px-2 py-3 text-center text-sm text-muted">{t("myTasksBoard.filters.noPeople")}</li>}
        </ul>
      </section>

      {channels.length > 0 && (
        <section className="flex min-h-0 min-w-0 flex-col gap-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">{t("myTasksBoard.filters.channelsHeading")}</div>
          <label className="relative block">
            <Search size={15} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              type="search"
              value={channelQuery}
              onChange={(e) => setChannelQuery(e.target.value)}
              placeholder={t("myTasksBoard.filters.searchChannels")}
              aria-label={t("myTasksBoard.filters.searchChannels")}
              className="h-9 w-full rounded-xl border border-border bg-surface pl-9 pr-3 text-sm text-fg placeholder:text-muted/70 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
            />
          </label>
          <ul aria-label={t("myTasksBoard.filters.channelsHeading")} className="max-h-32 min-h-0 overflow-y-auto rounded-xl border border-border/60 bg-surface/60 p-1">
            {shownChannels.map((c) => (
              <li key={c.id}>
                <PickRow on={filter.channelIds.has(c.id)} onToggle={() => toggleChannel(c.id)}>
                  <span className="min-w-0 flex-1 truncate text-fg">{c.name}</span>
                </PickRow>
              </li>
            ))}
            {shownChannels.length === 0 && <li className="px-2 py-3 text-center text-sm text-muted">{t("myTasksBoard.filters.noChannels")}</li>}
          </ul>
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
        </section>
      )}
    </GlassCard>
  );
}
