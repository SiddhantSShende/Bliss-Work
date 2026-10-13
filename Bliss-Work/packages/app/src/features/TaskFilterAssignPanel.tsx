import { useId, useRef, useState } from "react";
import { Hash, Lock, Search, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Avatar } from "@taskboard/ui";
import type { ChannelDTO, UserDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { matchUser } from "../lib/matchUser";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { usePagedPicker } from "../lib/usePagedPicker";
import { PagedListBox } from "./PagedListBox";
import { listCopy, pagedState, Row } from "./AssignToPanel";
import { channelMemberIds, type ChannelMembers, type SentTaskFilter } from "../lib/sentTaskFilter";

type Tab = "people" | "channels";
const SEARCH_DEBOUNCE_MS = 250;

// Module-level so the hook's memo sees one stable function.
const matchesChannel = (c: ChannelDTO, q: string) => !q || c.name.toLowerCase().includes(q.toLowerCase());

/**
 * The My Tasks filter's People / Channels picker — the same server-paged,
 * searchable, checkbox-list pattern as the New Task dialog's "Assign to"
 * panel (same hooks, same list shell, same row), swapped in here for whole-org
 * search instead of a short list derived from already-loaded tasks.
 *
 * Selection lives in the caller's `filter` (by id); picking a channel here
 * never writes into `filter.personIds` — its members only show as softly
 * ticked (see `via`), exactly as the previous filter UI did.
 */
export function TaskFilterAssignPanel({
  filter,
  onTogglePerson,
  onToggleChannel,
  channelMembers,
}: {
  filter: SentTaskFilter;
  onTogglePerson: (id: string) => void;
  onToggleChannel: (id: string) => void;
  channelMembers?: ChannelMembers;
}) {
  const { t } = useTranslation("tasks");
  const [tab, setTab] = useState<Tab>("people");
  // The channels list is not requested until the tab has been opened once.
  const [channelsOpened, setChannelsOpened] = useState(false);
  const [queries, setQueries] = useState<Record<Tab, string>>({ people: "", channels: "" });
  const baseId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const viaChannel = channelMemberIds(filter, channelMembers ?? new Map());

  const select = (next: Tab) => {
    setTab(next);
    if (next === "channels") setChannelsOpened(true);
  };
  const tabs: { id: Tab; icon: React.ReactNode; count: number }[] = [
    { id: "people", icon: <User size={16} aria-hidden />, count: filter.personIds.size },
    { id: "channels", icon: <Hash size={16} aria-hidden />, count: filter.channelIds.size },
  ];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2.5">
      <div role="tablist" aria-label={t("myTasksBoard.filters.peopleChannelsTabs")} className="grid grid-cols-2 gap-1.5 rounded-xl bg-surface-2 p-1">
        {tabs.map(({ id, icon, count }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`${baseId}-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`${baseId}-panel-${id}`}
            onClick={() => select(id)}
            className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
              tab === id ? "border-accent/40 bg-accent-soft text-accent" : "border-transparent text-muted hover:text-fg"
            }`}
          >
            {icon}
            {t(`createTaskDialog.assign.${id}Tab`, { count })}
          </button>
        ))}
      </div>

      <div className="relative">
        <Search size={16} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input
          ref={searchRef}
          type="search"
          value={queries[tab]}
          onChange={(e) => setQueries((q) => ({ ...q, [tab]: e.target.value }))}
          onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
          placeholder={t(`createTaskDialog.assign.${tab}Search`)}
          aria-label={t(`createTaskDialog.assign.${tab}SearchLabel`)}
          maxLength={100}
          className="h-9 w-full rounded-xl border border-border bg-surface-2 pl-9 pr-3 text-sm text-fg placeholder:text-muted focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
        />
      </div>

      <div role="tabpanel" id={`${baseId}-panel-people`} aria-labelledby={`${baseId}-tab-people`} hidden={tab !== "people"} className="flex min-h-0 flex-1 flex-col">
        <PeopleList query={queries.people} filter={filter} viaChannel={viaChannel} onToggle={onTogglePerson} />
      </div>
      {channelsOpened && (
        <div role="tabpanel" id={`${baseId}-panel-channels`} aria-labelledby={`${baseId}-tab-channels`} hidden={tab !== "channels"} className="flex min-h-0 flex-1 flex-col">
          <ChannelList query={queries.channels} filter={filter} onToggle={onToggleChannel} />
        </div>
      )}
    </div>
  );
}

function PeopleList({
  query,
  filter,
  viaChannel,
  onToggle,
}: {
  query: string;
  filter: SentTaskFilter;
  viaChannel: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  const { t } = useTranslation("tasks");
  const { api } = useRuntime();
  const me = useSession((s) => s.user);
  const list = usePagedPicker<UserDTO>({
    cacheKey: "filter-people",
    query: useDebouncedValue(query, SEARCH_DEBOUNCE_MS),
    fetchPage: ({ q, offset, limit }) => api.directoryPage({ q, offset, limit }),
    matches: matchUser,
  });
  return (
    <PagedListBox
      label={t("myTasksBoard.filters.peopleListLabel")}
      count={list.items.length}
      {...pagedState(list)}
      copy={listCopy(t, "people")}
    >
      {list.items.map((u) => {
        const name = u.displayName || u.username;
        const explicit = filter.personIds.has(u.id);
        const via = !explicit && viaChannel.has(u.id);
        return (
          <Row key={u.id} checked={explicit || via} via={via ? t("myTasksBoard.filters.viaChannel") : undefined} onToggle={() => onToggle(u.id)}>
            <Avatar name={name} src={u.avatarUrl} size="md" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
              {name}
              {u.id === me?.id && <span className="ml-1 font-normal text-muted">{t("createTaskDialog.fields.you")}</span>}
            </span>
            <span className="max-w-[45%] shrink-0 truncate text-xs text-muted">@{u.username}</span>
          </Row>
        );
      })}
    </PagedListBox>
  );
}

function ChannelList({
  query,
  filter,
  onToggle,
}: {
  query: string;
  filter: SentTaskFilter;
  onToggle: (id: string) => void;
}) {
  const { t } = useTranslation("tasks");
  const { api } = useRuntime();
  const list = usePagedPicker<ChannelDTO>({
    cacheKey: "filter-channels",
    query: useDebouncedValue(query, SEARCH_DEBOUNCE_MS),
    fetchPage: ({ q, offset, limit }) => api.channelsPage({ q, offset, limit }),
    matches: matchesChannel,
  });
  return (
    <PagedListBox
      label={t("myTasksBoard.filters.channelsListLabel")}
      count={list.items.length}
      {...pagedState(list)}
      copy={listCopy(t, "channels")}
    >
      {list.items.map((c) => (
        <Row key={c.id} checked={filter.channelIds.has(c.id)} onToggle={() => onToggle(c.id)}>
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
            <Hash size={16} aria-hidden />
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{c.name}</span>
          {c.isLocked && <Lock size={13} aria-label={t("createTaskDialog.assign.locked")} className="shrink-0 text-muted" />}
          <span className="shrink-0 text-xs text-muted">{t("createTaskDialog.assign.members", { count: c.memberCount })}</span>
        </Row>
      ))}
    </PagedListBox>
  );
}
