/**
 * Pure TanStack cache patch helpers used by WsEventBridge for the new inbox
 * events. Side effects are limited to qc.setQueryData / qc.invalidateQueries.
 *
 * Kept out of queryBridge.tsx so the bridge stays a thin switch and so these
 * helpers can be unit-tested without React.
 */
import type { QueryClient } from "@tanstack/react-query";
import type {
  InboxItemDTO,
  InboxPageDTO,
  MessageCreated,
  MessageDelivered,
  MessageDismissed,
  MessageDTO,
  MessageRead,
  ConversationIgnored,
} from "@taskboard/shared";
import { qk } from "./queryBridge";
import { appendMessage } from "./threadPagination";

// Inbox cache shape: TanStack InfiniteData<InboxPageDTO>.
type InboxInfinite = { pages: InboxPageDTO[]; pageParams: (string | undefined)[] };
// Thread cache shape: InfiniteData<MessageDTO[]>.
type ThreadInfinite = { pages: MessageDTO[][]; pageParams: (number | undefined)[] };

/**
 * Hoist a thread to the top of the unified inbox feed on MessageCreated.
 *
 * MAIL THREADS ONLY. The server stopped writing inbox_items rows for chat in
 * migration 0014; patching optimistically here regardless would put back
 * exactly the rows it declines to write, and the user would watch chat messages
 * appear in the Inbox and then vanish on the next refetch. Absent origin means
 * a producer older than 0014, whose threads are all being treated as chat.
 */
export function patchInboxOnMessage(qc: QueryClient, e: MessageCreated, meId: string): void {
  if (e.origin !== "mail") return;
  const threadId = e.threadId ?? e.conversationId;
  const peerId = e.senderId === meId ? e.recipientId : e.senderId;
  const isFromMe = e.senderId === meId;

  qc.setQueryData<InboxInfinite>(qk.unifiedInbox, (prev) => {
    if (!prev) return prev;
    const page0 = prev.pages[0];
    if (!page0) return prev;
    const flat = prev.pages.flatMap((p) => p.items);
    const existing = flat.find((it) => it.itemKind === "THREAD" && it.refId === threadId);
    const peerUsername = existing?.peerUsername ?? null;

    const next: InboxItemDTO = {
      ownerUserId: meId,
      itemKind: "THREAD",
      refId: threadId,
      peerUserId: peerId,
      peerUsername,
      preview: e.body.slice(0, 80),
      lastEventAt: e.occurredAt,
      unreadCount: isFromMe
        ? existing?.unreadCount ?? 0
        : (existing?.unreadCount ?? 0) + 1,
      statusBadge: isFromMe ? "SENT" : existing?.statusBadge ?? null,
      hiddenForOwner: false, // Reply revives both sides.
      deletedForOwner: false,
    };

    // Remove the thread's existing row wherever it currently lives (any page,
    // not just page 0), then prepend the fresh one — this is correct no matter
    // which page the row was on before.
    const filtered = flat.filter(
      (it) => !(it.itemKind === "THREAD" && it.refId === threadId),
    );
    const reordered = [next, ...filtered];

    // Re-chunk back into pages of their ORIGINAL sizes so pagination
    // boundaries (and the pageParams cursors that index them) stay valid —
    // only the content shifts. This also reproduces the old "drop the worst
    // row" behavior for a genuinely new thread (reordered can be one longer
    // than flat), but now the dropped row is always the true last item across
    // every loaded page, never a still-visible one, and the hoisted thread is
    // never left behind on its old page.
    let cursor = 0;
    const pages = prev.pages.map((p) => {
      const size = p.items.length;
      const items = reordered.slice(cursor, cursor + size);
      cursor += size;
      return { ...p, items };
    });

    return { ...prev, pages };
  });
}

/** Push a freshly arrived message into the open ThreadView page-1 cache. */
export function patchThreadOnMessage(qc: QueryClient, e: MessageCreated): void {
  const threadId = e.threadId ?? e.conversationId;
  qc.setQueryData<ThreadInfinite>(qk.threadMessages(threadId), (prev) => {
    if (!prev) return prev;
    const msg: MessageDTO = {
      id: e.messageId,
      conversationId: e.conversationId,
      threadId,
      parentMessageId: e.parentMessageId ?? null,
      isThreadRoot: e.isThreadRoot ?? false,
      seq: e.seq,
      senderId: e.senderId,
      body: e.body,
      kind: e.kind,
      createdAt: e.occurredAt,
    };
    const page0 = appendMessage(prev.pages[0] ?? [], msg);
    return { ...prev, pages: [page0, ...prev.pages.slice(1)] };
  });
}

/** Drop the thread row from the unified inbox on ConversationIgnored. */
export function patchInboxOnIgnored(qc: QueryClient, e: ConversationIgnored): void {
  if (!e.threadId) {
    // Legacy /conversations/{id}/ignore (still DMView's Ignore button and
    // ChatsList's Delete-chat, per messaging-svc's Store.Ignore) carries only
    // conversationId — never enough to scope a cache patch: InboxItemDTO's
    // THREAD rows key on `refId`, which is the THREAD id, not a conversation
    // id, and the item shape has no conversationId field at all to match
    // e.conversationId against. This used to filter out every THREAD row
    // regardless (the comment even admitted "conv match would go here" was
    // never implemented), wiping the entire unified inbox's mail threads on
    // any single Ignore/Delete. Rather than guess with insufficient data,
    // fall back to invalidating so the next refetch reflects the server's
    // real state — the item this call can't identify locally still
    // disappears, just not instantly, and nothing else is touched.
    void qc.invalidateQueries({ queryKey: qk.unifiedInbox });
    return;
  }
  qc.setQueryData<InboxInfinite>(qk.unifiedInbox, (prev) => {
    if (!prev) return prev;
    return {
      ...prev,
      pages: prev.pages.map((p) => ({
        ...p,
        items: p.items.filter(
          (it) => !(it.itemKind === "THREAD" && it.refId === e.threadId),
        ),
      })),
    };
  });
}

/**
 * Apply one receipt rule to BOTH caches a message can be sitting in.
 *
 * There are two, with different shapes and different owners: ThreadView reads
 * `qk.threadMessages` (InfiniteData, paginated), and DMView reads
 * `qk.messages` (one flat array — see its comment on why older pages are
 * prepended into it rather than paged).
 *
 * Patching only the first is the bug this exists to stop repeating. Delivery
 * and read receipts arrive as websocket events and are never re-fetched, so a
 * receipt applied to the thread cache alone simply never reached the DM screen:
 * the server computed SENT/DELIVERED/SEEN correctly, ListMessages returned it
 * correctly, and a bubble the recipient had visibly just read went on saying
 * nothing until something else happened to invalidate the conversation.
 */
function patchBothMessageCaches(
  qc: QueryClient,
  conversationId: string,
  threadId: string,
  rule: (m: MessageDTO) => MessageDTO,
): void {
  qc.setQueryData<ThreadInfinite>(qk.threadMessages(threadId), (prev) =>
    prev ? { ...prev, pages: prev.pages.map((page) => page.map(rule)) } : prev,
  );
  qc.setQueryData<MessageDTO[]>(qk.messages(conversationId), (prev) =>
    prev ? prev.map(rule) : prev,
  );
}

/** Bump a sender-side message bubble to DELIVERED status. */
export function patchThreadOnDelivered(qc: QueryClient, e: MessageDelivered): void {
  const threadId = e.threadId ?? e.conversationId;
  patchBothMessageCaches(qc, e.conversationId, threadId, (m) =>
    // SEEN outranks DELIVERED and the two events can land out of order, so this
    // never writes over a bubble that has already been read.
    m.id === e.messageId && m.status !== "SEEN" ? { ...m, status: "DELIVERED" } : m,
  );
}

/** Bump every sender-side bubble in this thread up to upToSeq to SEEN. */
export function patchThreadOnRead(qc: QueryClient, e: MessageRead, meId: string): void {
  const threadId = e.threadId ?? e.conversationId;
  patchBothMessageCaches(qc, e.conversationId, threadId, (m) =>
    m.senderId === meId && m.seq <= e.upToSeq ? { ...m, status: "SEEN" } : m,
  );
}

/** Reflect a sender-side soft-delete locally. */
export function patchOnDismissed(qc: QueryClient, e: MessageDismissed): void {
  const threadId = e.threadId ?? e.conversationId;
  qc.setQueryData<ThreadInfinite>(qk.threadMessages(threadId), (prev) => {
    if (!prev) return prev;
    return {
      ...prev,
      pages: prev.pages.map((page) =>
        page.map((m) =>
          m.id === e.messageId ? { ...m, dismissedBySender: true } : m,
        ),
      ),
    };
  });
}
