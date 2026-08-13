import { useEffect, useMemo } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Avatar } from "@taskboard/ui";
import type { MessageDTO, UserDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { useSession } from "../store/session";
import { flatThreadMessages, useThreadMessages } from "../lib/useCursorPagination";
import { reconcileOptimistic } from "../lib/threadPagination";
import { ThreadView } from "../features/ThreadView";
import { Composer } from "../features/Composer";
import { PinButton } from "../features/PinButton";
import { useChatMedia } from "../features/useChatMedia";
import { useFileTransfers } from "../lib/fileTransfer";

/**
 * Main pane content for /app/inbox/thread/:threadId.
 *
 * Loads the thread header (ThreadDTO), the most recent 16 messages, and
 * supports reverse-infinite scroll for older pages. New messages from the
 * peer arrive via the queryBridge MessageCreated handler — no manual
 * subscription here.
 *
 * Send path is optimistic: we synthesize a temp:* MessageDTO before the
 * server returns, then reconcile when the 201 lands.
 */
export function InboxThread() {
  const { threadId } = useParams<{ threadId: string }>();
  const me = useSession((s) => s.user);
  // Guard HERE — only useParams + useSession run before it. The heavy hooks live
  // in InboxThreadContent so they are always called in the same order: a logout
  // (me -> null) or a threadId cleared mid-navigation can no longer change this
  // component's hook count and crash React ("rendered fewer hooks than expected").
  if (!threadId || !me) return null;
  return <InboxThreadContent threadId={threadId} me={me} />;
}

function InboxThreadContent({ threadId, me }: { threadId: string; me: UserDTO }) {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const ft = useFileTransfers();

  const { data: header } = useQuery({
    queryKey: qk.thread(threadId),
    queryFn: () => api.thread(threadId),
  });

  const msgQuery = useThreadMessages(api, threadId);
  const messages = useMemo(() => flatThreadMessages(msgQuery.data), [msgQuery.data]);

  // Auto-mark-read when the newest seq advances past my last-read.
  useEffect(() => {
    if (!header || !messages.length) return;
    const last = messages[messages.length - 1];
    if (!last) return;
    const maxSeq = last.seq;
    if (maxSeq > header.lastMessageSeq /* sanity */) return;
    if (maxSeq > header.myLastReadSeq) {
      void api.readThread(threadId, maxSeq).catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, messages.length, header?.lastMessageSeq]);

  const sendMut = useMutation({
    mutationFn: async (body: string) => {
      // Optimistic temp message into the cache so the bubble renders instantly.
      const clientMsgId = crypto.randomUUID();
      const tempId = `temp:${clientMsgId}`;
      qc.setQueryData<{ pages: MessageDTO[][]; pageParams: unknown[] }>(qk.threadMessages(threadId), (prev) => {
        if (!prev) return prev;
        const m: MessageDTO = {
          id: tempId,
          conversationId: header?.conversationId ?? "",
          threadId,
          isThreadRoot: false,
          seq: (messages[messages.length - 1]?.seq ?? 0) + 1,
          senderId: me.id,
          body,
          createdAt: new Date().toISOString(),
          status: "PENDING",
        };
        const page0 = prev.pages[0] ?? [];
        return { ...prev, pages: [[...page0, m], ...prev.pages.slice(1)] };
      });
      const res = await api.replyToThread(threadId, body, { clientMsgId });
      const real: MessageDTO = {
        id: res.messageId,
        conversationId: header?.conversationId ?? "",
        threadId,
        isThreadRoot: false,
        seq: res.seq,
        senderId: me.id,
        body,
        createdAt: new Date().toISOString(),
        status: "SENT",
      };
      qc.setQueryData<{ pages: MessageDTO[][]; pageParams: unknown[] }>(qk.threadMessages(threadId), (prev) => {
        if (!prev) return prev;
        const page0 = reconcileOptimistic(prev.pages[0] ?? [], clientMsgId, real);
        return { ...prev, pages: [page0, ...prev.pages.slice(1)] };
      });
    },
  });

  const ignoreMut = useMutation({
    mutationFn: () => api.ignoreThread(threadId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.unifiedInbox }),
  });

  // Decorate the messages for ThreadView (senderName + at).
  const visual = useMemo(
    () =>
      messages.map((m) => ({
        id: m.id,
        senderId: m.senderId,
        senderName: m.senderId === me.id ? me.displayName : header?.peerUsername ?? "",
        body: m.body,
        at: m.createdAt,
        pending: m.id.startsWith("temp:"),
        status: m.status,
        kind: m.kind,
      })),
    [messages, me.id, me.displayName, header?.peerUsername],
  );

  // Attachments, shared locations and legacy peer-to-peer file offers all
  // render through one hook shared with the DM and channel surfaces.
  const media = useChatMedia({
    scope: "thread",
    scopeId: threadId,
    meId: me.id,
    send: (body) => sendMut.mutate(body),
    // 1:1 surface, so files over the server limit can still go peer-to-peer.
    p2pFallback: header ? (file) => void ft.send(file, threadId, header.peerId) : undefined,
  });

  return (
    <div className="flex h-full flex-col" {...media.dropzone}>
      {/* Thread header */}
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Avatar name={header?.peerUsername ?? "?"} size="sm" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-fg">
              {header?.peerUsername ?? "Loading…"}
            </div>
            <div className="truncate text-[11px] text-muted">
              {header?.subjectPreview || "Thread"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {header && (
            <PinButton
              threadId={threadId}
              conversationId={header.conversationId}
              myUserId={me.id}
              peerUserId={header.peerId}
              peerUsername={header.peerUsername}
            />
          )}
          <button
            onClick={() => ignoreMut.mutate()}
            className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-danger"
            title="Ignore — hides for both sides"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <ThreadView
        messages={visual}
        meId={me.id}
        hasMore={!!msgQuery.hasNextPage}
        onLoadMore={() => void msgQuery.fetchNextPage()}
        isFetchingPrev={msgQuery.isFetchingNextPage}
        renderBody={media.renderBody}
      />

      <Composer
        onSend={(text) => sendMut.mutate(text)}
        onAttach={media.onAttach}
        onShareLocation={media.onShareLocation}
        onPaste={media.onPaste}
        dragging={media.dragging}
      />
      <input {...media.fileInputProps} />
      {media.overlay}
    </div>
  );
}
