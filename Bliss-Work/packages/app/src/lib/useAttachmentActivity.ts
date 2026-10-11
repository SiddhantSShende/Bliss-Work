import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AttachmentScope, ChannelMessageDTO } from "@taskboard/shared";
import { useRuntime } from "./runtime";
import { useSession } from "../store/session";
import { getSessionId } from "./telemetrySession";
import { qk } from "./queryKeys";

/** The two file-activity kinds this hook can post. A subset of MessageKind —
 *  kept as its own type so a caller cannot accidentally pass an unrelated
 *  system kind through here. */
export type AttachmentActivityKind = "attachment_opened" | "attachment_downloaded";

/** True for the two stored message kinds this hook produces. */
export function isAttachmentActivityKind(kind: string | undefined): boolean {
  return kind === "attachment_opened" || kind === "attachment_downloaded";
}

/**
 * Whether file activity is VISIBLE in this chat's timeline — the one rule for
 * both posting it (below) and drawing it (ChannelView/DMView). Only a LOCKED
 * (private) channel shows it. Open channels and 1:1/group chats never do; the
 * activity there lives only in the member activity timeline. Fails closed: an
 * unknown lock state (`undefined`) shows nothing.
 */
export function showsAttachmentActivity(scope: AttachmentScope, channelLocked?: boolean): boolean {
  return scope === "channel" && channelLocked === true;
}

/**
 * Records "{name} opened/downloaded {file}" for a file attachment that was just
 * opened or downloaded in a chat or channel. TWO independent effects, mirroring
 * ScreenshotNotice's beacon + in-chat notice:
 *
 *   1. ALWAYS — a telemetry beacon (`attachment.opened` / `attachment.downloaded`)
 *      so the member's activity timeline has the event whatever the chat type.
 *   2. ONLY when `showsAttachmentActivity` — a system message posted into the
 *      channel, rendered by ChatThread as the same compact pill a screenshot
 *      notice uses (see messaging-svc's store.attachmentActionBody for the
 *      server-authored text this mirrors for the SENDER's own optimistic copy;
 *      the realtime bridge skips echoing the sender's own messages — see
 *      queryBridge's handleMessageEvent — on the assumption a mutation already
 *      rendered it, so this patches the cache itself, as ScreenshotNotice does).
 *
 * `contextName` is what the chat or channel the file was in is CALLED — the peer's
 * display name for a 1:1 chat, the channel's name for a channel — captured here,
 * at the moment of the action, from the surface the caller is already showing. It
 * is stored on the activity row beside the file name (`contextKind`/`contextId`/
 * `contextName`), so the timeline can say WHERE without anyone having to work it
 * back out from a file name later. Omitted (a caller with no name to give) it
 * simply leaves the row without a context, exactly as every row before this was.
 *
 * `channelLocked` is the channel's own `isLocked`, from the channel the caller is
 * already showing. DMs and group chats (scope "conversation") never post a
 * message, so they need nothing.
 *
 * Fire-and-forget: failing to record or post never blocks or undoes the
 * open/download that triggered it — that action already succeeded.
 *
 * Only chat (scope "conversation") and channel (scope "channel") attachments are
 * handled, so other scopes are a no-op. Mail attachments (scope "mail") are
 * deliberately NOT handled here: a mail download is recorded server-side
 * instead — see useMailAttachmentDownload.
 */
export function useAttachmentActivity(
  scope: AttachmentScope,
  scopeId: string,
  meId: string,
  channelLocked?: boolean,
  contextName?: string,
) {
  const { api, config } = useRuntime();
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

      // Recorded for every chat type, whether or not it is also shown in the chat.
      // Flushed on its own, as ScreenshotNotice's beacon is: a deliberate act, not
      // ambient traffic worth batching. Telemetry failure is swallowed — it must
      // never break, or interrupt, the thing it observes.
      const name = contextName?.trim();
      const context = name
        ? {
            contextKind: scope === "channel" ? "channel" : "direct",
            contextId: scopeId,
            contextName: name.slice(0, 255),
          }
        : {};
      let tracked: Promise<unknown>;
      try {
        tracked = Promise.resolve(
          api.sendBeacon({
            sessionId: getSessionId(),
            source: config.kind === "electron" ? "desktop" : "web",
            activeMs: 0,
            idleMs: 0,
            ended: false,
            events: [
              {
                action: kind === "attachment_opened" ? "attachment.opened" : "attachment.downloaded",
                category: "engagement",
                occurredAt: new Date().toISOString(),
                clientEventId: crypto.randomUUID(),
                surface: scope === "channel" ? "channels" : "chats",
                targetKind: "attachment",
                targetId: item.id,
                detail: { filename: item.name.slice(0, 255), [scope]: scopeId, ...context },
              },
            ],
          }),
        ).catch(() => {});
      } catch {
        tracked = Promise.resolve();
      }

      if (!showsAttachmentActivity(scope, channelLocked)) {
        void tracked.finally(clear);
        return;
      }

      // Computed the same way store.attachmentActionBody authors it
      // server-side, for the sender's own instant, optimistic pill — the
      // server is still the one writing the row, this is only ever what gets
      // painted locally before its response comes back.
      const actor = user.displayName || user.username;
      const verb = kind === "attachment_opened" ? "opened" : "downloaded";
      const body = `${actor} ${verb} ${item.name}`;
      const createdAt = new Date().toISOString();
      const clientMsgId = crypto.randomUUID();

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
    [api, channelLocked, config.kind, contextName, meId, qc, scope, scopeId, user],
  );
}
