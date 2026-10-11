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

type Tab = "people" | "channels";
const SEARCH_DEBOUNCE_MS = 250;

// Module-level so the hook's memo sees one stable function.
const matchesChannel = (c: ChannelDTO, q: string) => !q || c.name.toLowerCase().includes(q.toLowerCase());

/**
 * "Assign to" for the New Task dialog: a People tab and a Channels tab, each a
 * searchable, server-paged, scroll-loaded list of checkboxes.
 *
 * What is selected is the CALLER's (id sets, plus the channel's name/size at the
 * moment it was picked), never this panel's. That is what makes a selection survive
 * everything the lists do — paging, searching, a tab switch, an unmount — and what
 * lets the form submit ids it never had in memory as rows. Both lists stay mounted
 * once visited (the other is only hidden), so a tab keeps its search text, its
 * loaded pages and its scroll position.
 */
export function AssignToPanel({
  people,
  channels,
  onTogglePerson,
  onToggleChannel,
}: {
  people: ReadonlySet<string>;
  channels: ReadonlySet<string>;
  onTogglePerson: (user: UserDTO) => void;
  onToggleChannel: (channel: ChannelDTO) => void;
}) {
  const { t } = useTranslation("tasks");
  const [tab, setTab] = useState<Tab>("people");
  // The channels list is not requested until the tab has been opened once.
  const [channelsOpened, setChannelsOpened] = useState(false);
  const [queries, setQueries] = useState<Record<Tab, string>>({ people: "", channels: "" });
  const headingId = useId();
  const baseId = useId();
  const searchRef = useRef<HTMLInputElement>(null);

  const select = (next: Tab) => {
    setTab(next);
    if (next === "channels") setChannelsOpened(true);
  };
  const tabs: { id: Tab; icon: React.ReactNode; count: number }[] = [
    { id: "people", icon: <User size={16} aria-hidden />, count: people.size },
    { id: "channels", icon: <Hash size={16} aria-hidden />, count: channels.size },
  ];

  return (
    <div role="group" aria-labelledby={headingId} className="flex min-h-0 min-w-0 flex-1 flex-col gap-2.5">
      <span id={headingId} className="text-sm font-medium text-fg">
        {t("createTaskDialog.fields.assignTo")}
        <span className="ml-0.5 text-danger" aria-hidden>*</span>
        <span className="sr-only"> ({t("createTaskDialog.assign.required")})</span>
      </span>

      <div role="tablist" aria-label={t("createTaskDialog.fields.assignTo")} className="grid grid-cols-2 gap-1.5 rounded-xl bg-surface-2 p-1">
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
          // Enter belongs to the search, never to submitting the task form behind it.
          onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
          placeholder={t(`createTaskDialog.assign.${tab}Search`)}
          aria-label={t(`createTaskDialog.assign.${tab}SearchLabel`)}
          maxLength={100}
          className="h-9 w-full rounded-xl border border-border bg-surface-2 pl-9 pr-3 text-sm text-fg placeholder:text-muted focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
        />
      </div>

      <div role="tabpanel" id={`${baseId}-panel-people`} aria-labelledby={`${baseId}-tab-people`} hidden={tab !== "people"} className="flex min-h-0 flex-1 flex-col">
        <PeopleList query={queries.people} selected={people} onToggle={onTogglePerson} />
      </div>
      {channelsOpened && (
        <div role="tabpanel" id={`${baseId}-panel-channels`} aria-labelledby={`${baseId}-tab-channels`} hidden={tab !== "channels"} className="flex min-h-0 flex-1 flex-col">
          <ChannelList query={queries.channels} selected={channels} onToggle={onToggleChannel} />
        </div>
      )}
    </div>
  );
}

function listCopy(t: (k: string) => string, kind: "people" | "channels") {
  return {
    loading: t("createTaskDialog.assign.loading"),
    loadingMore: t(`createTaskDialog.assign.${kind}LoadingMore`),
    empty: t(`createTaskDialog.assign.${kind}Empty`),
    error: t("createTaskDialog.assign.loadError"),
    retry: t("createTaskDialog.assign.retry"),
  };
}

function PeopleList({ query, selected, onToggle }: { query: string; selected: ReadonlySet<string>; onToggle: (u: UserDTO) => void }) {
  const { t } = useTranslation("tasks");
  const { api } = useRuntime();
  const me = useSession((s) => s.user);
  const list = usePagedPicker<UserDTO>({
    cacheKey: "assign-people",
    query: useDebouncedValue(query, SEARCH_DEBOUNCE_MS),
    fetchPage: ({ q, offset, limit }) => api.directoryPage({ q, offset, limit }),
    matches: matchUser,
  });
  return (
    <PagedListBox
      label={t("createTaskDialog.assign.peopleListLabel")}
      count={list.items.length}
      {...pagedState(list)}
      copy={listCopy(t, "people")}
    >
      {list.items.map((u) => {
        const name = u.displayName || u.username;
        const checked = selected.has(u.id);
        return (
          <Row key={u.id} checked={checked} onToggle={() => onToggle(u)}>
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

function ChannelList({ query, selected, onToggle }: { query: string; selected: ReadonlySet<string>; onToggle: (c: ChannelDTO) => void }) {
  const { t } = useTranslation("tasks");
  const { api } = useRuntime();
  const list = usePagedPicker<ChannelDTO>({
    cacheKey: "assign-channels",
    query: useDebouncedValue(query, SEARCH_DEBOUNCE_MS),
    fetchPage: ({ q, offset, limit }) => api.channelsPage({ q, offset, limit }),
    matches: matchesChannel,
  });
  return (
    <PagedListBox
      label={t("createTaskDialog.assign.channelsListLabel")}
      note={t("createTaskDialog.fields.channelHint")}
      count={list.items.length}
      {...pagedState(list)}
      copy={listCopy(t, "channels")}
    >
      {list.items.map((c) => (
        <Row key={c.id} checked={selected.has(c.id)} onToggle={() => onToggle(c)}>
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

function pagedState(list: {
  isLoading: boolean;
  isRefreshing: boolean;
  isLoadingMore: boolean;
  isError: boolean;
  hasMore: boolean | undefined;
  loadMore: () => void;
  retry: () => void;
}) {
  return {
    isLoading: list.isLoading,
    isRefreshing: list.isRefreshing,
    isLoadingMore: list.isLoadingMore,
    isError: list.isError,
    hasMore: !!list.hasMore,
    onLoadMore: list.loadMore,
    onRetry: list.retry,
  };
}

/** One selectable row. A label around a real checkbox: the whole row is the click
 *  target, and keyboard and screen-reader behaviour come with the control. */
function Row({ checked, onToggle, children }: { checked: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <li>
      <label
        className={`flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-1.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent/40 ${
          checked ? "bg-accent-soft" : "hover:bg-surface-2"
        }`}
      >
        {children}
        <input type="checkbox" checked={checked} onChange={onToggle} className="h-4 w-4 shrink-0 cursor-pointer accent-[var(--color-accent)]" />
      </label>
    </li>
  );
}
