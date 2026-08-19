import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { FolderOpen, Inbox, PenSquare, RefreshCw, X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EmptyState, IconButton } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { INBOX_KINDS } from "../lib/inboxKinds";
import { peerLabel, useInboxPeers } from "../lib/useInboxPeers";
import { flatInbox, useInboxPages } from "../lib/useCursorPagination";
import { useMarkPeerRead } from "../lib/useMarkPeerRead";
import {
  folderOf,
  folderSpec,
  groupByDay,
  inFolder,
  isListableFolder,
  mailSearch,
  peerOf,
} from "../lib/mailView";
import { Tabs } from "../features/Tabs";
import { MailRow } from "../features/MailRow";

/**
 * How few rows are too few to stop paging at.
 *
 * The folder and unread filters run over the rows already loaded, so a page of
 * 25 can reduce to two visible ones — a "Sent Items" folder that looks empty
 * next to a scrollbar that has nothing left to scroll. Below this the next page
 * is pulled without waiting for the scroll sentinel.
 */
const MIN_VISIBLE = 12;

/**
 * Mail's second container: the messages in the selected folder, newest first,
 * keyset-paginated and bucketed by day — with the All/Unread filters and New
 * Mail above them.
 *
 * ── What narrows it ──────────────────────────────────────────────────────────
 * Two filters, both carried in the URL (see lib/mailView) so they survive
 * opening a mail and coming back:
 *   ?box=  — the folder. Applied here rather than server-side: direction is
 *            `statusBadge`, which the feed already carries, so a second
 *            endpoint would buy nothing.
 *   ?p=    — one counterparty, chosen in the folder column. This one IS
 *            server-side (the feed is a different keyset), which is also what
 *            makes opening a person the moment their rows are marked read.
 * The Unread tab is local state: it is a way of looking at the list, not a
 * place in the app worth linking to.
 *
 * Rows carry inline actions: MAIL → Delete (removes YOUR copy only); THREAD →
 * Ignore. The canonical state transitions all run through messaging-svc; the
 * WsEventBridge reconciles caches.
 */
export function MailList() {
  const [params] = useSearchParams();
  const peerId = peerOf(params);
  const folder = folderOf(params);
  const search = mailSearch(folder, peerId);
  const spec = folderSpec(folder);
  // Drafts / Deleted Items / Spam have no listing behind them at all — see
  // lib/mailView for why each one is structurally empty.
  const listable = isListableFolder(folder);

  const { api, config } = useRuntime();
  const qc = useQueryClient();
  const sentinel = useRef<HTMLDivElement>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);

  const q = useInboxPages(api, peerId, INBOX_KINDS);
  const items = flatInbox(q.data);

  useMarkPeerRead(api, peerId, items);

  const visible = useMemo(
    () =>
      listable
        ? items.filter((it) => inFolder(it, folder) && (!unreadOnly || it.unreadCount > 0))
        : [],
    [items, folder, listable, unreadOnly],
  );
  const groups = useMemo(() => groupByDay(visible), [visible]);

  // Heading label for a per-person feed — read from the People-list cache (cheap).
  const { data: peers = [] } = useInboxPeers({ enabled: !!peerId });
  const peer = peerId ? peers.find((p) => p.peerId === peerId) : undefined;
  const peerName = peer ? peerLabel(peer).name : "this person";

  // Desktop-only pin set: a pinned (locked) task can only be completed, so its
  // row must not offer Ignore. Empty/disabled on web.
  const { data: pinnedIds = [] } = useQuery({
    queryKey: qk.taskPins,
    queryFn: () => config.listPinned!(),
    enabled: !!config.listPinned,
    refetchOnWindowFocus: true,
  });

  const fetchMore = () => {
    // Paging through the whole mailbox to fill a folder the feed can never
    // answer for would be every request for nothing.
    if (listable && q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
  };

  // IntersectionObserver-driven next-page fetch.
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) fetchMore();
      },
      { rootMargin: "240px" },
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.hasNextPage, q.isFetchingNextPage, listable]);

  // A filtered list can be short enough that the sentinel never moves, which is
  // the one case the observer cannot recover from on its own.
  useEffect(() => {
    if (visible.length < MIN_VISIBLE) fetchMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.length, q.hasNextPage, q.isFetchingNextPage, listable]);

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
      // MAIL is one-sided: it hides the row for THIS reader and leaves the
      // sender's Sent copy — and every other recipient's — untouched. That is
      // what "delete" means in a mail client, and it is not the same act as a
      // thread ignore, which hides for both parties.
      if (kind === "MAIL") return api.ignoreInboxItem("MAIL", refId);
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
      <header className="shrink-0 border-b border-border/60 px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <Tabs
            tabs={[
              { key: "all", label: "All" },
              { key: "unread", label: "Unread" },
            ]}
            active={unreadOnly ? "unread" : "all"}
            onChange={(k) => setUnreadOnly(k === "unread")}
          />
          <div className="flex shrink-0 items-center gap-1.5">
            {/* New Mail ROUTES rather than opening a dialog. Composing an email
                is not a two-field confirmation — it is To/Cc/Bcc, a subject, a
                body and attachments — and a modal that size covers the very
                list the user is addressing from. The composer takes the reading
                pane, exactly where the mail it answers would have been read. */}
            <Link
              to={{ pathname: "/app/mail/compose", search }}
              title="New Mail — compose an email"
              className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-gradient-to-br from-brand-from to-brand-to px-2.5 text-xs font-semibold text-accent-fg shadow-[0_6px_20px_-6px_var(--color-accent)] transition-all hover:brightness-105 active:scale-[0.98]"
            >
              <PenSquare size={14} /> New Mail
            </Link>
            <IconButton
              onClick={refresh}
              title="Check for new mail"
              aria-label="Check for new mail"
              className="h-8 w-8"
            >
              <RefreshCw size={15} className={q.isFetching ? "animate-spin" : undefined} />
            </IconButton>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted">
          {/* A neutral folder glyph rather than the selected folder's own
              icon: this line says WHICH folder is on screen, and repeating the
              icon the folder column already shows beside the same word buys
              nothing — while an envelope sitting next to "Spam" reads wrong. */}
          <span className="inline-flex items-center gap-1.5 font-medium text-fg/70">
            <FolderOpen size={13} className="text-accent" /> {spec.label}
          </span>
          {/* How many rows the two filters actually left. Without it a folder
              that pages in slowly is indistinguishable from an empty one. */}
          {visible.length > 0 && (
            <span className="tabular-nums">
              {visible.length}
              {q.hasNextPage ? "+" : ""}{" "}
              {visible.length === 1 && !q.hasNextPage ? "message" : "messages"}
            </span>
          )}
          {peerId && (
            // The folder column is a level above this pane and scrolls
            // independently, so the person a short list is narrowed to has to
            // be sayable — and undoable — from here.
            <Link
              to={{ pathname: "/app/mail/all", search: mailSearch(folder) }}
              title="Show mail from everyone"
              className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 font-medium text-accent transition-colors hover:brightness-95"
            >
              {peerName} <X size={11} />
            </Link>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-2 pb-3 pt-1">
        {/* A folder with no listing behind it says so, and says why. It is not
            loading and it is not filtered — there is nothing that could ever
            arrive in it, which is a different thing from an empty mailbox. */}
        {!listable && (
          <EmptyState
            icon={<FolderOpen size={22} />}
            title={`${spec.label} is empty`}
            hint={spec.unavailable}
          />
        )}

        {listable && q.isLoading && <FeedSkeleton />}

        {listable && visible.length === 0 && !q.isLoading && !q.isFetchingNextPage && (
          <EmptyState
            icon={<Inbox size={22} />}
            title={unreadOnly ? "Nothing unread" : "Nothing here yet"}
            hint={
              unreadOnly
                ? "Everything in this folder has been read."
                : peerId
                  ? `No mail with ${peerName} in ${spec.label}.`
                  : "Choose New Mail to write one."
            }
          />
        )}

        {groups.map((group) => (
          <section key={group.label} className="mb-2">
            {/* Sticky so the day a row belongs to stays readable while its
                bucket is being scrolled past. */}
            <h3 className="sticky top-0 z-10 -mx-2 mb-0.5 bg-surface/80 px-5 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted backdrop-blur">
              {group.label}
            </h3>
            {group.items.map((it) => {
              // A pinned, still-acknowledged task is locked: hide its Ignore (X)
              // so the lock can't be bypassed from the feed.
              const locked =
                it.itemKind === "TASK" &&
                it.statusBadge === "ACKNOWLEDGED" &&
                pinnedIds.includes(it.refId);
              return (
                <MailRow
                  key={`${it.itemKind}:${it.refId}`}
                  item={it}
                  search={search}
                  onIgnore={locked ? undefined : (kind, refId) => ignoreMut.mutate({ kind, refId })}
                  onDismiss={(refId) => dismissMut.mutate(refId)}
                  onAcknowledge={(refId) => ackMut.mutate(refId)}
                  onComplete={(refId) => completeMut.mutate(refId)}
                />
              );
            })}
          </section>
        ))}

        {/* IntersectionObserver target for keyset paging. */}
        <div ref={sentinel} className="h-4" />
        {q.isFetchingNextPage && listable && (
          <div className="py-2 text-center text-[11px] text-muted">Loading more…</div>
        )}
      </div>
    </div>
  );
}

/**
 * First-load placeholder for the message column.
 *
 * Only ever shown before the first page arrives — after that the list has rows
 * to keep on screen while it refetches, and swapping them for grey bars would
 * be a step backwards. Four rows is roughly a screenful at this density, and
 * they carry no text: a skeleton that guesses at content is a skeleton that is
 * wrong for a moment.
 */
function FeedSkeleton() {
  return (
    <div aria-hidden className="space-y-1 px-1 pt-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex animate-pulse items-start gap-3 px-2 py-3">
          <span className="h-9 w-9 shrink-0 rounded-full bg-surface-2" />
          <div className="min-w-0 flex-1 space-y-2 pt-0.5">
            <div className="h-3 w-1/3 rounded bg-surface-2" />
            <div className="h-3 w-4/5 rounded bg-surface-2" />
            <div className="h-2.5 w-3/5 rounded bg-surface-2" />
          </div>
        </div>
      ))}
    </div>
  );
}
