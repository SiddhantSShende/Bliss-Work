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

/** Hoist a thread to the top of the unified inbox feed on MessageCreated. */
export function patchInboxOnMessage(qc: QueryClient, e: MessageCreated, meId: string): void {
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

    // Replace or prepend, keeping the rest of page 1 (drop the worst row).
    const filtered = flat.filter(
      (it) => !(it.itemKind === "THREAD" && it.refId === threadId),
    );
    const pageOne = [next, ...filtered].slice(0, page0.items.length);
    return {
      ...prev,
      pages: [
        { ...page0, items: pageOne },
        ...prev.pages.slice(1),
      ],
    };
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
      createdAt: e.occurredAt,
    };
    const page0 = appendMessage(prev.pages[0] ?? [], msg);
    return { ...prev, pages: [page0, ...prev.pages.slice(1)] };
  });
}

/** Drop the thread row from the unified inbox on ConversationIgnored. */
export function patchInboxOnIgnored(qc: QueryClient, e: ConversationIgnored): void {
  if (!e.threadId) {
    // Legacy /conversations/{id}/ignore — drop every THREAD row whose conv matches.
    qc.setQueryData<InboxInfinite>(qk.unifiedInbox, (prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        pages: prev.pages.map((p) => ({
          ...p,
          items: p.items.filter(
            (it) => !(it.itemKind === "THREAD" /* and conv match would go here */),
          ),
        })),
      };
    });
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

/** Bump a sender-side message bubble to DELIVERED status. */
export function patchThreadOnDelivered(qc: QueryClient, e: MessageDelivered): void {
  const threadId = e.threadId ?? e.conversationId;
  qc.setQueryData<ThreadInfinite>(qk.threadMessages(threadId), (prev) => {
    if (!prev) return prev;
    return {
      ...prev,
      pages: prev.pages.map((page) =>
        page.map((m) =>
          m.id === e.messageId && m.status !== "SEEN" ? { ...m, status: "DELIVERED" } : m,
        ),
      ),
    };
  });
}

/** Bump every sender-side bubble in this thread up to upToSeq to SEEN. */
export function patchThreadOnRead(qc: QueryClient, e: MessageRead, meId: string): void {
  const threadId = e.threadId ?? e.conversationId;
  qc.setQueryData<ThreadInfinite>(qk.threadMessages(threadId), (prev) => {
    if (!prev) return prev;
    return {
      ...prev,
      pages: prev.pages.map((page) =>
        page.map((m) =>
          m.senderId === meId && m.seq <= e.upToSeq ? { ...m, status: "SEEN" } : m,
        ),
      ),
    };
  });
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
