import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ApiClient, InboxItemDTO, InboxPeerDTO } from "@taskboard/shared";
import { qk } from "./queryBridge";

/** Server clamps `upToSeq` to the latest seq the caller is allowed to mark
 *  read, so passing a value > any real seq reliably means "mark everything
 *  read I can see". int64 max keeps it future-proof. */
const READ_ALL_SEQ = Number.MAX_SAFE_INTEGER;

type InboxCache = { pages: { items: InboxItemDTO[]; nextCursor: string | null }[] };

/**
 * Mark-as-read on view: when the user opens a peer's feed, every unread row of
 * theirs is marked read on the server AND the People-list cache is
 * optimistically patched so the "N" badge disappears the instant they click.
 * Without the optimistic patch the badge would linger until the server fan-out
 * makes it back through the next inboxPeers refetch.
 *
 * Tracked per (peerId, row) so a user re-opening the same peer doesn't re-fire
 * the requests, but a brand-new unread arriving (and the user re-opening) does.
 *
 * Note this marks a mail read on OPENING THE PERSON, not on opening the mail —
 * matching what the People pill claims, which is "this person has nothing new
 * for you". Opening the mail itself also marks it read (see MailDetail); both
 * are idempotent, so whichever happens first wins.
 */
export function useMarkPeerRead(api: ApiClient, peerId: string | undefined, items: InboxItemDTO[]) {
  const qc = useQueryClient();
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
    // unread marks on individual rows in the list column match the People pill.
    const patchUnread = (list: InboxItemDTO[]) =>
      list.map((it) =>
        it.peerUserId === peerId && it.unreadCount > 0 ? { ...it, unreadCount: 0 } : it,
      );
    const patchPages = (data: InboxCache | undefined) =>
      data
        ? { ...data, pages: data.pages.map((p) => ({ ...p, items: patchUnread(p.items) })) }
        : data;
    qc.setQueryData<InboxCache>(qk.unifiedInbox, patchPages);
    qc.setQueryData<InboxCache>(qk.inboxPeerFeed(peerId), patchPages);

    // Authoritative, per kind. Best-effort — if a call fails the next
    // People-list refetch resurfaces the count and the user can re-open to
    // retry.
    //
    // THREAD goes to /threads/{id}/read (it has a seq model); MAIL has none, so
    // it goes through the inbox mark-read endpoint, which routes to the mail's
    // own read_at.
    const unread = items.filter(
      (it) =>
        it.peerUserId === peerId &&
        it.unreadCount > 0 &&
        (it.itemKind === "THREAD" || it.itemKind === "MAIL") &&
        !markedRef.current.has(it.refId),
    );
    unread.forEach((it) => {
      markedRef.current.add(it.refId);
      const done =
        it.itemKind === "THREAD"
          ? api.readThread(it.refId, READ_ALL_SEQ)
          : api.readInboxItem("MAIL", it.refId);
      void done.catch(() => {
        // Allow a retry on the next mount.
        markedRef.current.delete(it.refId);
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerId, items.length]);
}
