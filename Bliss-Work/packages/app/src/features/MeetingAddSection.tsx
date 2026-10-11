import { useId, useState } from "react";
import { Check, Hash, Lock, Search, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Avatar } from "@taskboard/ui";
import type { ChannelDTO, UserDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { matchUser } from "../lib/matchUser";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { usePagedPicker } from "../lib/usePagedPicker";
import { MEETING_TONES } from "./meetingTone";
import { PICKER_TONES, type PickerTone } from "./pickerTone";
import { PickerScrollList } from "./PickerScrollList";

/** How long the search box waits after the last keystroke before asking the server. */
const SEARCH_DEBOUNCE_MS = 250;

type Tab = "people" | "channels";

/**
 * "Add" on the New Meeting form: who is asked to the meeting, as two tabs over the
 * same pattern — People (the default) and Channels. Each is a search box over a
 * fixed-height scrolling list that is paged from the server (usePagedPicker): the first
 * page when the tab first shows, the next as the list is scrolled toward its end, the
 * search done server-side. Neither the organisation's members nor its channels are ever
 * downloaded whole.
 *
 * Selection is the caller's (`Set`s of ids), so it survives paging, searching and
 * switching tabs; the callers are told each pick's NAME as well, since the row that
 * carried it may not be loaded any more when the preview wants to print it. Switching
 * tabs keeps each tab's search text and scroll position (both lists stay mounted).
 *
 * People excludes the caller — they are the host. Channels are the ones the caller is in,
 * the only ones the server accepts.
 */
export function MeetingAddSection({
  invitees,
  onTogglePerson,
  channels,
  onToggleChannel,
  error,
  tone = "light",
}: {
  invitees: Set<string>;
  onTogglePerson: (userId: string, name: string) => void;
  channels: Set<string>;
  onToggleChannel: (channelId: string, name: string) => void;
  /** Shown under the section once the form has been submitted without anyone added. */
  error?: string;
  tone?: PickerTone;
}) {
  const { t } = useTranslation("meetings");
  const [tab, setTab] = useState<Tab>("people");
  const ids = { label: useId(), people: useId(), channels: useId() };
  const mt = MEETING_TONES[tone];
  const pt = PICKER_TONES[tone];

  const tabButton = (value: Tab, label: string, count: number) => {
    const on = tab === value;
    const Icon = value === "people" ? User : Hash;
    return (
      <button
        type="button"
        role="tab"
        id={`${ids[value]}-tab`}
        aria-selected={on}
        aria-controls={ids[value]}
        onClick={() => setTab(value)}
        className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
          on ? "bg-accent/15 text-accent" : `${mt.muted} hover:bg-black/5`
        }`}
      >
        <Icon size={15} aria-hidden />
        {label}
        <span className="font-normal">({count})</span>
      </button>
    );
  };

  return (
    <div className="flex flex-col gap-1.5" data-testid="meeting-add-section">
      <span id={ids.label} className={`text-sm font-medium ${mt.label}`}>
        {t("newMeeting.add.label")}
        <span className="ml-0.5 text-danger" aria-hidden="true">*</span>
      </span>
      <div
        role="tablist"
        aria-labelledby={ids.label}
        className={`flex gap-1 rounded-lg border p-0.5 ${pt.list}`}
      >
        {tabButton("people", t("newMeeting.add.people"), invitees.size)}
        {tabButton("channels", t("newMeeting.add.channels"), channels.size)}
      </div>

      <div id={ids.people} role="tabpanel" aria-labelledby={`${ids.people}-tab`} hidden={tab !== "people"}>
        <PeopleList active={tab === "people"} selected={invitees} onToggle={onTogglePerson} tone={tone} />
      </div>
      <div id={ids.channels} role="tabpanel" aria-labelledby={`${ids.channels}-tab`} hidden={tab !== "channels"}>
        <ChannelsList active={tab === "channels"} selected={channels} onToggle={onToggleChannel} tone={tone} />
      </div>

      {error && (
        <span className="text-xs text-danger" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function SearchBox({
  value,
  onChange,
  placeholder,
  label,
  tone,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
  tone: PickerTone;
}) {
  const c = PICKER_TONES[tone];
  return (
    <div className="relative">
      <Search size={14} className={`pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 ${c.icon}`} />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className={`w-full rounded-lg border py-2 pl-9 pr-3 text-sm outline-none ${c.input}`}
      />
    </div>
  );
}

const rowClass = (on: boolean, c: (typeof PICKER_TONES)[PickerTone]) =>
  `flex w-full items-center gap-2.5 rounded-lg p-2 text-left ${on ? c.on : c.off}`;

function PeopleList({
  active,
  selected,
  onToggle,
  tone,
}: {
  active: boolean;
  selected: Set<string>;
  onToggle: (id: string, name: string) => void;
  tone: PickerTone;
}) {
  const { t } = useTranslation("meetings");
  const { t: tOrg } = useTranslation("org");
  const { api } = useRuntime();
  const me = useSession((s) => s.user);
  const [q, setQ] = useState("");
  const query = useDebouncedValue(q, SEARCH_DEBOUNCE_MS);
  const c = PICKER_TONES[tone];

  const list = usePagedPicker<UserDTO>({
    cacheKey: "meeting-people",
    query,
    enabled: active,
    fetchPage: ({ q: search, offset, limit }) => api.directoryPage({ q: search, offset, limit }),
    matches: matchUser,
  });
  const people = list.items.filter((u) => u.id !== me?.id);

  return (
    <div className="flex flex-col gap-2">
      <SearchBox
        value={q}
        onChange={setQ}
        placeholder={tOrg("inviteePicker.searchPlaceholder")}
        label={tOrg("inviteePicker.searchAriaLabel")}
        tone={tone}
      />
      <PickerScrollList
        tone={tone}
        label={t("newMeeting.add.people")}
        isLoading={list.isLoading}
        isError={list.isError}
        isLoadingMore={list.isLoadingMore}
        hasMore={!!list.hasMore}
        isEmpty={people.length === 0 && !list.hasMore && !list.isRefreshing}
        onNearEnd={list.loadMore}
        onRetry={list.retry}
        text={{
          loading: tOrg("inviteePicker.loading"),
          loadingMore: t("newMeeting.add.loadingMore"),
          error: t("newMeeting.add.loadError"),
          retry: t("newMeeting.channelPicker.retry"),
          empty: query.trim() ? tOrg("inviteePicker.empty.noMatches") : tOrg("inviteePicker.empty.noneToInvite"),
        }}
      >
        {people.map((u) => {
          const on = selected.has(u.id);
          return (
            <button
              type="button"
              key={u.id}
              onClick={() => onToggle(u.id, u.displayName || u.username)}
              aria-pressed={on}
              className={rowClass(on, c)}
            >
              <Avatar name={u.displayName} src={u.avatarUrl} size="sm" className={c.avatar} />
              <span className={`min-w-0 flex-1 truncate text-sm ${c.text}`}>{u.displayName}</span>
              <span className={`shrink-0 truncate text-xs ${c.muted}`}>@{u.username}</span>
              {on && <Check size={15} className="shrink-0 text-accent" />}
            </button>
          );
        })}
      </PickerScrollList>
    </div>
  );
}

function ChannelsList({
  active,
  selected,
  onToggle,
  tone,
}: {
  active: boolean;
  selected: Set<string>;
  onToggle: (id: string, name: string) => void;
  tone: PickerTone;
}) {
  const { t } = useTranslation("meetings");
  const { api } = useRuntime();
  const [q, setQ] = useState("");
  const query = useDebouncedValue(q, SEARCH_DEBOUNCE_MS);
  const c = PICKER_TONES[tone];

  const list = usePagedPicker<ChannelDTO>({
    cacheKey: "meeting-channels",
    query,
    enabled: active,
    fetchPage: ({ q: search, offset, limit }) => api.channelsPage({ q: search, offset, limit }),
    matches: matchChannel,
  });
  const channels = list.items;

  return (
    <div className="flex flex-col gap-2">
      <SearchBox
        value={q}
        onChange={setQ}
        placeholder={t("newMeeting.channelPicker.searchPlaceholder")}
        label={t("newMeeting.channelPicker.searchAriaLabel")}
        tone={tone}
      />
      <PickerScrollList
        tone={tone}
        label={t("newMeeting.add.channels")}
        isLoading={list.isLoading}
        isError={list.isError}
        isLoadingMore={list.isLoadingMore}
        hasMore={!!list.hasMore}
        isEmpty={channels.length === 0 && !list.hasMore && !list.isRefreshing}
        onNearEnd={list.loadMore}
        onRetry={list.retry}
        text={{
          loading: t("newMeeting.channelPicker.loading"),
          loadingMore: t("newMeeting.add.loadingMore"),
          error: t("newMeeting.channelPicker.error"),
          retry: t("newMeeting.channelPicker.retry"),
          empty: query.trim()
            ? t("newMeeting.channelPicker.empty.noMatches")
            : t("newMeeting.channelPicker.empty.none"),
        }}
      >
        {channels.map((ch) => {
          const on = selected.has(ch.id);
          const Icon = ch.isLocked ? Lock : Hash;
          return (
            <button
              type="button"
              key={ch.id}
              onClick={() => onToggle(ch.id, ch.name)}
              aria-pressed={on}
              className={rowClass(on, c)}
            >
              <Icon size={15} className={`shrink-0 ${c.muted}`} aria-hidden />
              <span className={`min-w-0 flex-1 truncate text-sm ${c.text}`}>{ch.name}</span>
              <span className={`shrink-0 text-xs ${c.muted}`}>
                {t("newMeeting.channelPicker.members", { count: ch.memberCount })}
              </span>
              {on && <Check size={15} className="shrink-0 text-accent" />}
            </button>
          );
        })}
      </PickerScrollList>
    </div>
  );
}

/** Module-level so usePagedPicker's memo stays stable. */
function matchChannel(ch: ChannelDTO, q: string): boolean {
  const needle = q.trim().toLowerCase();
  return !needle || ch.name.toLowerCase().includes(needle);
}
