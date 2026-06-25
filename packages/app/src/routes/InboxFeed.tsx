import { useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { Inbox } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InboxItemDTO, InboxPeerDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { flatInbox, useInboxPages } from "../lib/useCursorPagination";
import { InboxRow } from "../features/InboxRow";

/** Server clamps `upToSeq` to the latest seq the caller is allowed to mark
 *  read, so passing a value > any real seq reliably means "mark everything
 *  read I can see". int64 max keeps it future-proof. */
const READ_ALL_SEQ = Number.MAX_SAFE_INTEGER;

/**
 * Right (main) pane of /app/inbox. The unified feed of messages + tasks, newest
 * first, keyset-paginated. With a :peerId route param the feed is narrowed to
 * one counterparty (the People-sidebar drill-down); without it, everything.
 *
 * Rows carry inline actions: THREAD → Reply (drills into the thread) / Ignore;
 * TASK → Acknowledge (SENT) / Complete (ACKNOWLEDGED) / Ignore (SENT). The
 * canonical state transitions all run through task-svc / messaging-svc; the
 * WsEventBridge reconciles caches (and auto-pins on acknowledge).
 */
export function InboxFeed() {
  const { peerId } = useParams<{ peerId?: string }>();
  const { api, config } = useRuntime();
  const qc = useQueryClient();
  const sentinel = useRef<HTMLDivElement>(null);

  const q = useInboxPages(api, peerId);
  // allItems retains both kinds; we use it to mark threads as read below.
  // `items` is the displayed list — TASK-only because DMs live in /app/chats.
  const allItems = flatInbox(q.data);
  const items = allItems.filter((item) => item.itemKind === "TASK");

  // Mark-as-read on view: when the user opens a peer's feed, every unread
  // thread is sent a /threads/{id}/read request AND the People-list cache is
  // optimistically patched so the "N" badge disappears the instant they
  // click. Without the optimistic patch the badge would linger until the
  // server fan-out makes it back through the next inboxPeers refetch.
  // Tracked per (peerId, threadId set) so a user re-opening the same peer
  // doesn't re-fire the requests, but a brand-new unread arriving (and the
  // user re-opening) does.
  const markedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!peerId) return;
    // Optimistic: zero this peer's unread count in the People-list cache.
    qc.setQueryData<InboxPeerDTO[]>(qk.inboxPeers, (prev) =>
      (prev ?? []).map((p) =>
        p.peerId === peerId && p.unreadCount > 0 ? { ...p, unreadCount: 0 } : p,
      ),
    );
    // Optimistic: zero the unread on every row in the current feed too — the
    // "N" pills on individual rows in the right pane match the People pill.
    const patchUnread = (list: InboxItemDTO[]) =>
      list.map((it) =>
        it.peerUserId === peerId && it.unreadCount > 0 ? { ...it, unreadCount: 0 } : it,
      );
    qc.setQueryData<{ pages: { items: InboxItemDTO[]; nextCursor: string | null }[] }>(
      qk.unifiedInbox,
      (data) =>
        data
          ? { ...data, pages: data.pages.map((p) => ({ ...p, items: patchUnread(p.items) })) }
          : data,
    );
    qc.setQueryData<{ pages: { items: InboxItemDTO[]; nextCursor: string | null }[] }>(
      qk.inboxPeerFeed(peerId),
      (data) =>
        data
          ? { ...data, pages: data.pages.map((p) => ({ ...p, items: patchUnread(p.items) })) }
          : data,
    );

    // Authoritative: hit /threads/{id}/read for each thread we haven't yet
    // marked. Best-effort — if a call fails the next People-list refetch
    // resurfaces the count and the user can re-open to retry.
    const threads = allItems.filter(
      (it) =>
        it.itemKind === "THREAD" &&
        it.peerUserId === peerId &&
        it.unreadCount > 0 &&
        !markedRef.current.has(it.refId),
    );
    threads.forEach((thread) => {
      markedRef.current.add(thread.refId);
      void api.readThread(thread.refId, READ_ALL_SEQ).catch(() => {
        // Allow a retry on the next mount.
        markedRef.current.delete(thread.refId);
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerId, allItems.length]);

  // Heading label for a per-person feed — read from the People-list cache (cheap).
  const { data: peers = [] } = useQuery({
    queryKey: qk.inboxPeers,
    queryFn: () => api.inboxPeers(),
    enabled: !!peerId,
  });
  const peer = peerId ? peers.find((p) => p.peerId === peerId) : undefined;
  const heading = peerId ? peer?.displayName ?? peer?.username ?? "Conversation" : "All";

  // Desktop-only pin set: a pinned (locked) task can only be completed, so its
  // row must not offer Ignore. Empty/disabled on web.
  const { data: pinnedIds = [] } = useQuery({
    queryKey: qk.taskPins,
    queryFn: () => config.listPinned!(),
    enabled: !!config.listPinned,
    refetchOnWindowFocus: true,
  });

  // IntersectionObserver-driven next-page fetch.
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[0];
        if (e?.isIntersecting && q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
      },
      { rootMargin: "240px" },
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.hasNextPage, q.isFetchingNextPage]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.unifiedInbox });
    void qc.invalidateQueries({ queryKey: qk.inboxPeers });
    void qc.invalidateQueries({ queryKey: ["inboxPeerFeed"] });
    // qk.sticky drives both the desktop sticky reconcile AND the browser
    // overlay (BrowserStickies). The TaskAcknowledged WS event patches the
    // cache too, but the patch is in-place — if the cache is empty (newly
    // assigned task that hasn't been fetched), the patch is a no-op. A direct
    // invalidate guarantees the freshly-acked task lands in the overlay
    // immediately, even before the WS round-trip completes.
    void qc.invalidateQueries({ queryKey: qk.sticky });
  };

  const ignoreMut = useMutation({
    mutationFn: async ({ kind, refId }: { kind: string; refId: string }) => {
      if (kind === "THREAD") return api.ignoreThread(refId);
      // TASK kind routes through the canonical task ignore so the state machine
      // + outbox both fire; the inbox projector updates inbox_items on its own.
      await api.taskAction(refId, "ignore");
    },
    onSuccess: refresh,
  });
  const dismissMut = useMutation({
    mutationFn: (messageId: string) => api.dismissMessage(messageId),
    onSuccess: refresh,
  });
  const ackMut = useMutation({
    mutationFn: (taskId: string) => api.taskAction(taskId, "acknowledge"),
    onSuccess: refresh,
  });
  const completeMut = useMutation({
    mutationFn: (taskId: string) => api.taskAction(taskId, "complete"),
    onSuccess: refresh,
  });

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-fg">
          <Inbox size={16} className="text-accent" /> {heading}
        </div>
        <div className="text-[11px] text-muted">
          {peerId
            ? "Tasks involving this person — DMs are in Chats"
            : "Tasks assigned to you, newest first — DMs are in Chats"}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {items.length === 0 && !q.isLoading && (
          <div className="px-4 py-8 text-center text-xs text-muted">
            {peerId
              ? "Nothing here with this person yet."
              : "Your inbox is empty. Tap + to start a thread or assign a task."}
          </div>
        )}
        {items.map((it) => {
          // A pinned, still-acknowledged task is locked: hide its Ignore (X) so
          // the lock can't be bypassed from the feed.
          const locked =
            it.itemKind === "TASK" && it.statusBadge === "ACKNOWLEDGED" && pinnedIds.includes(it.refId);
          return (
            <InboxRow
              key={`${it.itemKind}:${it.refId}`}
              item={it}
              onIgnore={locked ? undefined : (kind, refId) => ignoreMut.mutate({ kind, refId })}
              onDismiss={(refId) => dismissMut.mutate(refId)}
              onAcknowledge={(refId) => ackMut.mutate(refId)}
              onComplete={(refId) => completeMut.mutate(refId)}
            />
          );
        })}
        {/* IntersectionObserver target for keyset paging. */}
        <div ref={sentinel} className="h-4" />
        {q.isFetchingNextPage && <div className="py-2 text-center text-[11px] text-muted">Loading more…</div>}
      </div>
    </div>
  );
}
