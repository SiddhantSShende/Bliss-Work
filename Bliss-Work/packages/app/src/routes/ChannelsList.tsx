import { useMemo, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertCircle, Bell, BellOff, Compass, Globe, Hash, LogIn, LogOut, Lock, MoreVertical, Pin, Plus, Search } from "lucide-react";
import { Button, EmptyState } from "@taskboard/ui";
import type { ChannelDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { ListHeader, rowClass, relTime } from "../features/ListPane";
import { AddChannelDialog } from "../features/AddChannelDialog";
import { toggleConversationPref, useConversationPrefs } from "../lib/conversationPrefs";
import { usePopupDismiss } from "../lib/usePopupDismiss";
import { listPreview, withSenderLabel } from "../lib/chatEnvelope";
import { useJoinChannel } from "../lib/useJoinChannel";
import { LeaveChannelDialog } from "../features/LeaveChannelDialog";
import { useSession } from "../store/session";

/**
 * Middle pane of /app/channels.
 *
 * Tabs:
 *   • My channels   — channels the user is a member of (api.channels())
 *   • Browse        — directory of OPEN channels in the org the user can
 *                     self-join (api.openChannels()). Locked channels are
 *                     never listed here; you only see them via explicit
 *                     invite.
 *
 * The lock icon next to a channel name disambiguates the visibility model
 * at a glance — open channels show 🌐, locked channels show 🔒.
 */
type Tab = "mine" | "browse";

/** Browse page size. Matches the server's default so the first page is one
 *  request, and stays well under its max of 200. */
const OPEN_PAGE = 50;

export function ChannelsList() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const me = useSession((s) => s.user)!;
  const [newOpen, setNewOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("mine");
  const [leaveTarget, setLeaveTarget] = useState<ChannelDTO | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "unread">("all");

  const { data: mine = [] } = useQuery({
    queryKey: qk.channels,
    queryFn: () => api.channels(),
  });
  // Mute and "add shortcut", set from a channel's own overflow menu, are read
  // back here — this list is the only place either one is observable. Both are
  // device-local; see lib/conversationPrefs.
  const prefs = useConversationPrefs();

  // Shortcuts float to the top of "My channels"; everything else keeps the
  // server's order. A stable partition rather than a sort, so two pinned
  // channels stay in the order the list already put them in. Browse is left
  // alone: it is a directory of channels the reader is not in.
  const orderedMine = useMemo(() => {
    const pinned = mine.filter((c: ChannelDTO) => prefs.hasShortcut("channel", c.id));
    if (pinned.length === 0) return mine;
    return [...pinned, ...mine.filter((c: ChannelDTO) => !prefs.hasShortcut("channel", c.id))];
  }, [mine, prefs]);

  const visibleMine = useMemo(() => {
    const query = search.trim().toLowerCase();
    return orderedMine.filter((c: ChannelDTO) => {
      const matchesSearch = !query || c.name.toLowerCase().includes(query);
      const matchesFilter = filter === "all" || c.unread > 0;
      return matchesSearch && matchesFilter;
    });
  }, [orderedMine, search, filter]);
  const unreadCount = useMemo(
    () => mine.filter((c: ChannelDTO) => c.unread > 0).length,
    [mine],
  );
  // Browse lists every open channel in the ORG, so it is paged — the directory
  // grows with the customer, and an org with thousands of channels would
  // otherwise fetch and render all of them to show the first screenful.
  //
  // A short page means the end of the directory: the server clamps the limit and
  // returns fewer rows than asked for only when it has run out.
  const {
    data: openPages,
    fetchNextPage: fetchMoreOpen,
    hasNextPage: hasMoreOpen,
    isFetchingNextPage: fetchingMoreOpen,
    isError: openFailed,
    refetch: retryOpen,
  } = useInfiniteQuery({
    queryKey: qk.openChannels,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.openChannels({ limit: OPEN_PAGE, offset: pageParam }),
    getNextPageParam: (last, all) =>
      last.length < OPEN_PAGE ? undefined : all.length * OPEN_PAGE,
    enabled: tab === "browse",
  });
  const open: ChannelDTO[] = openPages?.pages.flat() ?? [];

  const joinMut = useJoinChannel();

  // Same call and confirmation ChannelView's header menu makes when leaving
  // from inside the channel — see confirmLeave there.
  const leaveMut = useMutation({
    mutationFn: (channelId: string) => api.leaveChannel(channelId),
    onSuccess: () => {
      toast.success("Left the channel.");
      void qc.invalidateQueries({ queryKey: qk.channels });
      void qc.invalidateQueries({ queryKey: qk.openChannels });
    },
    onError: (e) => toast.error("Couldn't leave", { description: String(e) }),
  });
  const confirmLeave = (c: ChannelDTO) => {
    setLeaveTarget(c);
  };

  return (
    <>
      <ListHeader
        title="Channels"
        action={
          <button
            onClick={() => setNewOpen(true)}
            title="Add channel"
            className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-brand-from to-brand-to text-accent-fg shadow-soft transition hover:brightness-105"
          >
            <Plus size={16} />
          </button>
        }
      />
      <div className="flex gap-1 px-2 pb-1">
        <TabButton active={tab === "mine"} onClick={() => setTab("mine")}>
          <Hash size={13} /> My channels
        </TabButton>
        <TabButton active={tab === "browse"} onClick={() => setTab("browse")}>
          <Compass size={13} /> Browse
        </TabButton>
      </div>
      {tab === "mine" && (
        <div className="space-y-2 border-b border-border/60 px-3 py-2">
          <label className="relative block">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              type="search"
              aria-label="Search channels"
              placeholder="Search channels..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-9 w-full rounded-lg border border-border bg-surface-2 pl-9 pr-3 text-sm text-fg outline-none placeholder:text-muted focus:border-accent"
            />
          </label>
          <div className="flex items-center" role="tablist" aria-label="Channel filters">
            {(["all", "unread"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={filter === value}
                onClick={() => setFilter(value)}
                className={`relative flex-1 px-2 py-1.5 text-xs font-medium capitalize transition-colors ${
                  filter === value
                    ? "text-accent after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent"
                    : "text-muted hover:text-fg"
                }`}
              >
                {value}
                {value === "unread" && unreadCount > 0 && (
                  <span className="ml-1.5 rounded-full bg-accent px-1.5 text-[10px] text-accent-fg">
                    {unreadCount}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1 space-y-0.5 overflow-auto p-2">
        {tab === "mine" ? (
          mine.length === 0 ? (
            <EmptyState
              icon={<Hash size={22} />}
              title="No channels yet"
              hint="Tap + to create one, or Browse to find open channels."
            />
          ) : visibleMine.length === 0 ? (
            <EmptyState icon={<Search size={22} />} title="No matching channels" hint="Try another search or filter." />
          ) : (
            visibleMine.map((c) => (
              <ChannelRow
                key={c.id}
                channel={c}
                muted={prefs.isMuted("channel", c.id)}
                shortcut={prefs.hasShortcut("channel", c.id)}
                isOwnLastMessage={c.lastMessageSenderId ? c.lastMessageSenderId === me.id : undefined}
                onToggleMute={() => toggleConversationPref("muted", "channel", c.id)}
                onTogglePin={() => toggleConversationPref("shortcut", "channel", c.id)}
                onLeave={() => confirmLeave(c)}
                leaving={leaveMut.isPending && leaveMut.variables === c.id}
              />
            ))
          )
        ) : openFailed ? (
          <div className="flex flex-col items-center gap-3">
            <EmptyState
              icon={<AlertCircle size={22} />}
              title="Couldn't load open channels"
              hint="Something went wrong fetching the directory."
            />
            <Button variant="ghost" size="sm" onClick={() => void retryOpen()}>
              Try again
            </Button>
          </div>
        ) : open.length === 0 ? (
          <EmptyState
            icon={<Compass size={22} />}
            title="No open channels to join"
            hint="Open channels created by your teammates will show up here."
          />
        ) : (
          <>
            {open.map((c) => (
              <OpenChannelRow
                key={c.id}
                channel={c}
                onJoin={() => joinMut.mutate(c.id)}
                joining={joinMut.isPending && joinMut.variables === c.id}
              />
            ))}
            {hasMoreOpen && (
              <div className="px-3 py-2">
                <Button
                  variant="ghost"
                  size="sm"
                  loading={fetchingMoreOpen}
                  onClick={() => void fetchMoreOpen()}
                >
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </div>
      <AddChannelDialog open={newOpen} onClose={() => setNewOpen(false)} />
      <LeaveChannelDialog
        channel={leaveTarget}
        open={!!leaveTarget}
        onClose={() => setLeaveTarget(null)}
        busy={leaveMut.isPending}
        onConfirm={() => {
          if (!leaveTarget) return;
          leaveMut.mutate(leaveTarget.id, { onSuccess: () => setLeaveTarget(null) });
        }}
      />
    </>
  );
}

function ChannelRow({
  channel: c,
  muted,
  shortcut,
  isOwnLastMessage,
  onToggleMute,
  onTogglePin,
  onLeave,
  leaving,
}: {
  channel: ChannelDTO;
  /** Muted on this device. */
  muted: boolean;
  shortcut: boolean;
  /** Whether the caller sent the channel's last message — only matters for
   *  the Link sent/Link received preview label; undefined when unknown. */
  isOwnLastMessage: boolean | undefined;
  onToggleMute: () => void;
  onTogglePin: () => void;
  onLeave: () => void;
  leaving: boolean;
}) {
  const unread = c.unread > 0;
  const Icon = c.isLocked ? Lock : Hash;
  // Not a NavLink around the whole row any more — see the same note on
  // ChatsList's row: the overflow menu is a button, and a button inside a
  // link's click target fights the link for the click. isActive is read
  // separately here because it drove the wrapper's rowClass, not just the
  // link's own styling.
  const isActive = useLocation().pathname === `/app/channels/${c.id}`;
  return (
    <div className={rowClass(isActive)}>
      <NavLink to={`/app/channels/${c.id}`} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Icon size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={`truncate ${unread ? "font-semibold text-fg" : "font-medium text-fg"}`}>
                {c.name}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted">
              {shortcut && <Pin size={11} aria-label="Pinned" className="text-accent" />}
              {muted && <BellOff size={11} aria-label="Muted" />}
              {relTime(c.lastMessageAt)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm text-muted">
              {c.cleared
                ? ""
                : c.lastMessage
                  ? withSenderLabel(listPreview(c.lastMessage, isOwnLastMessage), c.lastMessageSender || undefined)
                  : `${c.memberCount} member${c.memberCount === 1 ? "" : "s"}`}
            </span>
            {c.unread > 0 && (
              <span
                className={`shrink-0 rounded-full px-1.5 text-[11px] font-semibold ${
                  muted ? "bg-surface-2 text-muted" : "bg-accent text-accent-fg"
                }`}
              >
                {c.unread}
              </span>
            )}
          </div>
        </div>
      </NavLink>
      <ChannelListMenu
        muted={muted}
        pinned={shortcut}
        onToggleMute={onToggleMute}
        onTogglePin={onTogglePin}
        onLeave={onLeave}
        leaving={leaving}
      />
    </div>
  );
}

/** Overflow menu on a "My channels" row. Mirrors ChatsList's ChatListMenu —
 *  same trigger, same popup shell — with Leave in place of Delete: a channel
 *  is shared state you exit, not a thread only you own. */
function ChannelListMenu({
  muted,
  pinned,
  onToggleMute,
  onTogglePin,
  onLeave,
  leaving,
}: {
  muted: boolean;
  pinned: boolean;
  onToggleMute: () => void;
  onTogglePin: () => void;
  onLeave: () => void;
  leaving: boolean;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const wrap = usePopupDismiss<HTMLDivElement>(open, close);
  const pick = (run: () => void) => (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    close();
    run();
  };

  return (
    <div ref={wrap} className="relative shrink-0" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        title="Channel options"
        aria-label="Channel options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.preventDefault();
          setOpen((value) => !value);
        }}
        className="flex items-center rounded-lg px-1.5 py-1 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
      >
        <MoreVertical size={16} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Channel options"
          className="absolute right-0 z-[1000] mt-1.5 w-52 rounded-xl border border-border bg-surface p-1 shadow-card"
        >
          <ChannelListMenuItem
            icon={<Pin size={15} />}
            label={pinned ? "Unpin Channel" : "Pin Channel"}
            onClick={pick(onTogglePin)}
          />
          <ChannelListMenuItem
            icon={<LogOut size={15} />}
            label={leaving ? "Leaving…" : "Leave Channel"}
            onClick={leaving ? undefined : pick(onLeave)}
            danger
          />
          <ChannelListMenuItem
            icon={muted ? <Bell size={15} /> : <BellOff size={15} />}
            label={muted ? "Unmute Notifications" : "Mute Notifications"}
            onClick={pick(onToggleMute)}
          />
        </div>
      )}
    </div>
  );
}

function ChannelListMenuItem({
  icon,
  label,
  onClick,
  danger = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: (event: React.MouseEvent) => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={!onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors disabled:pointer-events-none disabled:opacity-45 ${
        danger ? "text-danger hover:bg-danger/10" : "text-fg hover:bg-surface-2"
      }`}
    >
      <span className={danger ? "" : "text-muted"}>{icon}</span>
      <span className="font-medium">{label}</span>
    </button>
  );
}

function OpenChannelRow({
  channel: c,
  onJoin,
  joining,
}: {
  channel: ChannelDTO;
  onJoin: () => void;
  joining: boolean;
}) {
  return (
    <div className="flex items-center gap-2 rounded-xl p-2 hover:bg-surface-2">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-soft text-accent">
        <Globe size={17} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm font-medium text-fg">
          <span className="truncate">{c.name}</span>
        </div>
        <div className="truncate text-xs text-muted">
          {c.memberCount} member{c.memberCount === 1 ? "" : "s"}
        </div>
      </div>
      <Button size="sm" variant="subtle" onClick={onJoin} loading={joining}>
        <LogIn size={13} /> Join
      </Button>
    </div>
  );
}

function TabButton({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-[11px] font-medium transition ${
        active
          ? "bg-accent text-accent-fg"
          : "bg-surface-2 text-muted hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}
