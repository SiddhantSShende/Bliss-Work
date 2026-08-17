import { useState } from "react";
import { NavLink } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Hash, Lock, Globe, LogIn, Compass } from "lucide-react";
import { Button, EmptyState } from "@taskboard/ui";
import type { ChannelDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { ListHeader, rowClass, relTime } from "../features/ListPane";
import { CreateChannelDialog } from "../features/CreateChannelDialog";

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
  const [newOpen, setNewOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("mine");

  const { data: mine = [] } = useQuery({
    queryKey: qk.channels,
    queryFn: () => api.channels(),
  });
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
  } = useInfiniteQuery({
    queryKey: qk.openChannels,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.openChannels({ limit: OPEN_PAGE, offset: pageParam }),
    getNextPageParam: (last, all) =>
      last.length < OPEN_PAGE ? undefined : all.length * OPEN_PAGE,
    enabled: tab === "browse",
  });
  const open: ChannelDTO[] = openPages?.pages.flat() ?? [];

  const joinMut = useMutation({
    mutationFn: (channelId: string) => api.joinChannel(channelId),
    onSuccess: () => {
      toast.success("Joined the channel.");
      void qc.invalidateQueries({ queryKey: qk.channels });
      void qc.invalidateQueries({ queryKey: qk.openChannels });
    },
    onError: (e) => toast.error("Couldn't join", { description: String(e) }),
  });

  return (
    <>
      <ListHeader
        title="Channels"
        action={
          <button
            onClick={() => setNewOpen(true)}
            title="New channel"
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
      <div className="min-h-0 flex-1 space-y-0.5 overflow-auto p-2">
        {tab === "mine" ? (
          mine.length === 0 ? (
            <EmptyState
              icon={<Hash size={22} />}
              title="No channels yet"
              hint="Tap + to create one, or Browse to find open channels."
            />
          ) : (
            mine.map((c) => <ChannelRow key={c.id} channel={c} />)
          )
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
      <CreateChannelDialog open={newOpen} onClose={() => setNewOpen(false)} />
    </>
  );
}

function ChannelRow({ channel: c }: { channel: ChannelDTO }) {
  const Icon = c.isLocked ? Lock : Hash;
  return (
    <NavLink
      to={`/app/channels/${c.id}`}
      className={({ isActive }) => rowClass(isActive)}
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-soft text-accent">
        <Icon size={17} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-medium text-fg">{c.name}</span>
          <span className="shrink-0 text-[10px] text-muted">{relTime(c.lastMessageAt)}</span>
        </div>
        <div className="truncate text-sm text-muted">
          {c.lastMessage ?? `${c.memberCount} member${c.memberCount === 1 ? "" : "s"}`}
        </div>
      </div>
    </NavLink>
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
