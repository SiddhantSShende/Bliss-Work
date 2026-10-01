import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AttachmentScope, ChannelMessageDTO, MessageDTO } from "@taskboard/shared";
import { useRuntime } from "./runtime";
import { useSession } from "../store/session";
import { qk } from "./queryKeys";

/** The two file-activity kinds this hook can post. A subset of MessageKind —
 *  kept as its own type so a caller cannot accidentally pass an unrelated
 *  system kind through here. */
export type AttachmentActivityKind = "attachment_opened" | "attachment_downloaded";

/**
 * Posts "{name} opened/downloaded {file}" into the same DM or channel a file
 * attachment was just opened or downloaded from — see ChatThread/ThreadView's
 * rendering of these two kinds for the resulting pill, and messaging-svc's
 * store.attachmentActionBody for the server-authored text this mirrors for
 * the SENDER's own optimistic copy (the realtime bridge skips echoing the
 * sender's own messages — see queryBridge's handleMessageEvent — on the
 * assumption a mutation already rendered it; there is no mutation here, so
 * this patches the cache itself, exactly as ScreenshotNotice does for its own
 * self-reported system message).
 *
 * Fire-and-forget: failing to post the activity notice never blocks or undoes
 * the open/download that triggered it — that action already succeeded.
 *
 * Only chat (scope "conversation") and channel (scope "channel") attachments
 * get an in-conversation activity notice, so scopes outside these two are a
 * no-op. Mail attachments (scope "mail") are deliberately NOT handled here: a
 * mail has no conversation to post a notice into, and a mail download is
 * recorded in the admin activity timeline instead — see
 * useMailAttachmentDownload.
 *
 * DMs post through `api.reply`, the SAME endpoint an ordinary chat reply
 * uses, rather than `api.sendMessage` — whose top-level-send path mints a
 * brand-new thread on every single call. A file can be opened or downloaded
 * far more often than a rare event like a screenshot attempt, and minting a
 * thread per occurrence would hijack the conversation's next ordinary reply,
 * nesting it under a throwaway activity notice instead. See messaging-svc's
 * store.ReplyAttachmentActivity doc comment for the full reasoning. Channels
 * have no such thread concept, so `api.sendChannelMessage` is used directly.
 */
export function useAttachmentActivity(scope: AttachmentScope, scopeId: string, meId: string) {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const user = useSession((s) => s.user);

  // Guards a double-click or a MediaBubble/Lightbox re-render firing the SAME
  // action a second time while the first request for it is still in flight.
  // Deliberately not a time debounce: once a key clears here, a genuinely
  // later, separate open/download of the same file posts its own activity
  // message, same as the product wants (see the feature's "duplicate
  // prevention" requirement).
  const inFlight = useRef<Set<string>>(new Set());

  return useCallback(
    (kind: AttachmentActivityKind, item: { id: string; name: string }) => {
      if (scope !== "conversation" && scope !== "channel") return;
      if (!user) return;

      const key = `${item.id}:${kind}`;
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      const clear = () => inFlight.current.delete(key);

      // Computed the same way store.attachmentActionBody authors it
      // server-side, for the sender's own instant, optimistic pill — the
      // server is still the one writing the row, this is only ever what gets
      // painted locally before its response comes back.
      const name = user.displayName || user.username;
      const verb = kind === "attachment_opened" ? "opened" : "downloaded";
      const body = `${name} ${verb} ${item.name}`;
      const createdAt = new Date().toISOString();
      const clientMsgId = crypto.randomUUID();

      if (scope === "conversation") {
        api
          .reply(scopeId, body, clientMsgId, undefined, kind, item.id)
          .then((res) => {
            qc.setQueryData<MessageDTO[]>(qk.messages(scopeId), (prev) => {
              const next = prev ? [...prev] : [];
              if (next.some((m) => m.id === res.messageId)) return next;
              next.push({
                id: res.messageId,
                conversationId: scopeId,
                threadId: res.threadId,
                seq: res.seq,
                senderId: meId,
                body,
                kind,
                createdAt,
              });
              return next.sort((a, b) => a.seq - b.seq);
            });
            qc.invalidateQueries({ queryKey: qk.conversations });
          })
          .catch((err) => console.error("[attachment-activity] failed to post", err))
          .finally(clear);
        return;
      }

      api
        .sendChannelMessage(scopeId, body, clientMsgId, kind, undefined, item.id)
        .then((res) => {
          qc.setQueryData<ChannelMessageDTO[]>(qk.channelMessages(scopeId), (prev) => {
            const next = prev ? [...prev] : [];
            if (next.some((m) => m.id === res.messageId)) return next;
            next.push({
              id: res.messageId,
              channelId: scopeId,
              seq: res.seq,
              senderId: meId,
              senderUsername: user.username,
              senderDisplayName: user.displayName,
              body,
              kind,
              createdAt,
            });
            return next.sort((a, b) => a.seq - b.seq);
          });
          qc.invalidateQueries({ queryKey: qk.channels });
        })
        .catch((err) => console.error("[attachment-activity] failed to post", err))
        .finally(clear);
    },
    [api, meId, qc, scope, scopeId, user],
  );
}
