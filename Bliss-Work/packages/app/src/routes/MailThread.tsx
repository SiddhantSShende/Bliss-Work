import { useEffect, useMemo } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Avatar } from "@taskboard/ui";
import type { MessageDTO, UserDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { displayNameOf } from "../lib/userLabel";
import { useSession } from "../store/session";
import { flatThreadMessages, useThreadMessages } from "../lib/useCursorPagination";
import { reconcileOptimistic } from "../lib/threadPagination";
import { ThreadView } from "../features/ThreadView";
import { Composer } from "../features/Composer";
import { PinButton } from "../features/PinButton";
import { useChatMedia } from "../features/useChatMedia";
import { useFileTransfers } from "../lib/fileTransfer";

/**
 * Main pane content for /app/mail/thread/:threadId.
 *
 * Loads the thread header (ThreadDTO), the most recent 16 messages, and
 * supports reverse-infinite scroll for older pages. New messages from the
 * peer arrive via the queryBridge MessageCreated handler — no manual
 * subscription here.
 *
 * Send path is optimistic: we synthesize a temp:* MessageDTO before the
 * server returns, then reconcile when the 201 lands.
 */
export function MailThread() {
  const { threadId } = useParams<{ threadId: string }>();
  const me = useSession((s) => s.user);
  // Guard HERE — only useParams + useSession run before it. The heavy hooks live
  // in MailThreadContent so they are always called in the same order: a logout
  // (me -> null) or a threadId cleared mid-navigation can no longer change this
  // component's hook count and crash React ("rendered fewer hooks than expected").
  if (!threadId || !me) return null;
  return <MailThreadContent threadId={threadId} me={me} />;
}

function MailThreadContent({ threadId, me }: { threadId: string; me: UserDTO }) {
  const { t } = useTranslation("mail");
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

  // Optimistic send with real error handling: onMutate inserts the temp
  // bubble, onSuccess reconciles it against the server's id/seq, and onError
  // removes it and toasts — mirroring useOptimisticSend (DMView/ChannelView).
  // This used to do the optimistic insert AND the send inside one
  // mutationFn with no onError at all: a failed api.replyToThread left the
  // "Sending…" bubble in the cache forever, with no error shown and no way
  // to retry short of navigating away and back.
  const sendMut = useMutation({
    // Scoped to this thread's queryKey, mirroring useOptimisticSend
    // (DMView/ChannelView): MailThreadContent is never remounted when the
    // URL's threadId param changes, so without a differing mutationKey,
    // TanStack Query's MutationObserver.setOptions() would rebind a still-
    // pending send's onSuccess/onError closures onto whichever thread is
    // open when it resolves — reconciling thread A's send against thread B's
    // cache instead of A's.
    mutationKey: qk.threadMessages(threadId),
    mutationFn: ({ body, clientMsgId }: { body: string; clientMsgId: string }) =>
      api.replyToThread(threadId, body, { clientMsgId }),
    onMutate: ({ body, clientMsgId }) => {
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
      return { tempId };
    },
    onSuccess: (res, { body, clientMsgId }) => {
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
    onError: (_err, _vars, ctx) => {
      qc.setQueryData<{ pages: MessageDTO[][]; pageParams: unknown[] }>(qk.threadMessages(threadId), (prev) => {
        if (!prev || !ctx) return prev;
        const page0 = (prev.pages[0] ?? []).filter((m) => m.id !== ctx.tempId);
        return { ...prev, pages: [page0, ...prev.pages.slice(1)] };
      });
      toast.error(t("thread.messageFailedToast"));
    },
  });

  const ignoreMut = useMutation({
    mutationFn: () => api.ignoreThread(threadId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.unifiedInbox }),
    onError: () => toast.error(t("thread.couldNotRemoveThreadToast")),
  });

  // The peer's real name. `peerUsername` is the email local-part, so it must
  // never be rendered on its own — see lib/userLabel.
  const peerName = header ? displayNameOf(header) : "";

  // Decorate the messages for ThreadView (senderName + at).
  const visual = useMemo(
    () =>
      messages.map((m) => ({
        id: m.id,
        senderId: m.senderId,
        senderName: m.senderId === me.id ? me.displayName : peerName,
        body: m.body,
        at: m.createdAt,
        pending: m.id.startsWith("temp:"),
        status: m.status,
        kind: m.kind,
      })),
    [messages, me.id, me.displayName, peerName],
  );

  // Attachments, shared locations and legacy peer-to-peer file offers all
  // render through one hook shared with the DM and channel surfaces.
  const media = useChatMedia({
    scope: "thread",
    scopeId: threadId,
    meId: me.id,
    send: (body) => sendMut.mutate({ body, clientMsgId: crypto.randomUUID() }),
    // 1:1 surface, so files over the server limit can still go peer-to-peer.
    p2pFallback: header ? (file) => void ft.send(file, threadId, header.peerId) : undefined,
  });

  return (
    <div className="flex h-full flex-col" {...media.dropzone}>
      {/* Thread header */}
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Avatar name={peerName || "?"} size="sm" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-fg">
              {peerName || t("shared.loading")}
            </div>
            <div className="truncate text-[11px] text-muted">
              {header?.subjectPreview || t("thread.defaultSubject")}
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
              peerUsername={peerName}
            />
          )}
          <button
            onClick={() => ignoreMut.mutate()}
            disabled={ignoreMut.isPending}
            className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
            title={t("thread.ignoreTitle")}
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <ThreadView
        threadId={threadId}
        messages={visual}
        meId={me.id}
        hasMore={!!msgQuery.hasNextPage}
        onLoadMore={() => void msgQuery.fetchNextPage()}
        isFetchingPrev={msgQuery.isFetchingNextPage}
        renderBody={media.renderBody}
      />

      <Composer
        // Keyed on threadId: MailThread is not remounted on a URL param
        // change (see ThreadView's own comment), so without this a draft
        // typed for one thread would still be sitting in the box — and get
        // sent — after navigating to a different one.
        key={threadId}
        // flushStaged, not sendMut.mutate: Send must emit the attachment tray
        // as well as the text, and must tolerate an empty text.
        onSend={(text) => media.flushStaged(text)}
        onAttach={media.onAttach}
        onShareLocation={media.onShareLocation}
        onPaste={media.onPaste}
        dragging={media.dragging}
        attachments={media.staged}
        onRemoveAttachment={media.removeStaged}
        uploading={Object.keys(media.uploads).length}
      />
      <input {...media.fileInputProps} />
      {media.overlay}
    </div>
  );
}
