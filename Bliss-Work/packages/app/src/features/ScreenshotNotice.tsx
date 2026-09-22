import { useCallback, useEffect } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { ChannelMessageDTO, MessageDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { surfaceOf } from "../lib/section";
import { getSessionId } from "../lib/telemetrySession";
import { watchCaptureKeys } from "../lib/screenGuard";
import { useActiveThread } from "../lib/activeThread";
import { qk } from "../lib/queryBridge";

/**
 * Warns the user on a detected screenshot attempt, and reports it to the server.
 *
 * Renders nothing. Mounted once, next to the <Toaster />, because an attempt can
 * happen on any screen and the warning has to appear wherever the user is.
 *
 * TWO DETECTORS, one message:
 *
 *   • Desktop — the Electron main process. It excludes the window from OS
 *     capture where the platform allows (Windows, macOS) and sees capture chords
 *     a page never receives. It tells us through `onScreenshotBlocked`.
 *   • Web — this page, via `watchCaptureKeys`. A browser cannot exclude itself
 *     from capture and cannot see the chords the shell swallows, so this is
 *     detection and warning only. It is installed ONLY when the desktop host is
 *     absent; running both would double-report the same keystroke.
 *
 * The attempt is reported to telemetry-svc so the control leaves a record on the
 * SERVER rather than a toast that vanishes with the tab — an admin can see it in
 * the member's activity timeline. Reporting is skipped when the desktop has
 * already recorded it through the activity agent (`recorded`), and when there is
 * no session to attribute it to. The warning itself always fires: a signed-out
 * user still gets told, we simply have nobody to record it against.
 *
 * ── The in-chat notice ────────────────────────────────────────────────────────
 * If a 1:1 chat or channel is open when the attempt happens, the SAME detected
 * event also posts an ordinary system message there — "X tried to take a
 * screenshot" — via the same send path any other message takes
 * (kind: "screenshot_attempt"; see ChatThread/ThreadView for how it renders).
 * This is a DIFFERENT concern from the telemetry beacon above and fires on its
 * own schedule: it does not care whether the desktop's activity agent already
 * recorded the attempt (that gate is about consented device monitoring, not
 * about whether the people in this conversation get told), and it does nothing
 * at all when no chat/channel is open — there is nowhere to post it. Which
 * thread is open comes from lib/activeThread, because this component is mounted
 * outside the router (see App.tsx) and cannot read that itself.
 *
 * ── Why this patches the cache itself ────────────────────────────────────────
 * DMView/ChannelView's own sends go through a useMutation with onMutate, which
 * is what puts the sender's OWN bubble on screen instantly — WsEventBridge
 * deliberately skips the sender's own echo (`senderId !== me`), because it
 * assumes the mutation already rendered it. This call bypasses that mutation
 * entirely (there is no composer event here, just a detected keystroke), so
 * without patching the cache directly, the person who tried the screenshot
 * would never see their own notice — only everyone else would, via the WS
 * event the send still emits. The response already carries the real id and
 * seq, so this writes the FINAL row, not a temp one to be swapped later.
 */
export function ScreenshotNotice() {
  const { t } = useTranslation("common");
  const { api, config } = useRuntime();
  const qc = useQueryClient();
  const authed = useSession((s) => s.status) === "authed";
  const user = useSession((s) => s.user);

  const onAttempt = useCallback(
    (chord: string, alreadyRecorded: boolean) => {
      // Read live, not via a closed-over hook value: this callback is bound
      // once and re-bound only when the effect below re-runs, so a value
      // captured at bind time can go stale between a route change and the
      // next render — a capture chord fired in that window would otherwise
      // post into the thread the user just navigated away from.
      const thread = useActiveThread.getState().thread;
      toast.error(t("screenshotBlocked"));
      // Both the beacon and the chat notice attribute to a signed-in user;
      // neither has anyone to report as without one.
      if (!authed || !user) return;

      if (!alreadyRecorded) {
        // Flushed on its own rather than queued with the ordinary beacon traffic:
        // a security event that arrives half an hour later, if the tab survives
        // that long, is worth much less than one that arrives now. Failure is
        // swallowed for the reason all telemetry is — it must never break, or
        // interrupt, the thing it observes.
        void api
          .sendBeacon({
            sessionId: getSessionId(),
            source: config.kind === "web" ? "web" : "desktop",
            activeMs: 0,
            idleMs: 0,
            ended: false,
            events: [
              {
                action: "screenshot.attempted",
                category: "security",
                occurredAt: new Date().toISOString(),
                surface: surfaceOf(window.location.pathname) ?? undefined,
                detail: { chord },
              },
            ],
          })
          .catch(() => {});
      }

      if (!thread) return;
      // Same fallback ChannelView already uses for "my own" name (username is
      // the email local-part — see lib/userLabel — so displayName wins whenever
      // it's set).
      const name = user.displayName || user.username;
      const body = `${name} tried to take a screenshot`;
      const createdAt = new Date().toISOString();

      if (thread.kind === "chat") {
        api
          .sendMessage(thread.peerId, body, undefined, "screenshot_attempt")
          .then((res) => {
            qc.setQueryData<MessageDTO[]>(qk.messages(thread.conversationId), (prev) => {
              const next = prev ? [...prev] : [];
              if (next.some((m) => m.id === res.messageId)) return next;
              next.push({
                id: res.messageId,
                conversationId: thread.conversationId,
                seq: res.seq,
                senderId: user.id,
                body,
                kind: "screenshot_attempt",
                createdAt,
              });
              return next.sort((a, b) => a.seq - b.seq);
            });
            qc.invalidateQueries({ queryKey: qk.conversations });
          })
          .catch((err) => console.error("[security] failed to post screenshot notice", err));
        return;
      }

      api
        .sendChannelMessage(thread.channelId, body, undefined, "screenshot_attempt")
        .then((res) => {
          qc.setQueryData<ChannelMessageDTO[]>(qk.channelMessages(thread.channelId), (prev) => {
            const next = prev ? [...prev] : [];
            if (next.some((m) => m.id === res.messageId)) return next;
            next.push({
              id: res.messageId,
              channelId: thread.channelId,
              seq: res.seq,
              senderId: user.id,
              senderUsername: user.username,
              senderDisplayName: user.displayName,
              body,
              kind: "screenshot_attempt",
              createdAt,
            });
            return next.sort((a, b) => a.seq - b.seq);
          });
          qc.invalidateQueries({ queryKey: qk.channels });
        })
        .catch((err) => console.error("[security] failed to post screenshot notice", err));
    },
    [api, authed, config.kind, qc, t, user],
  );

  useEffect(() => {
    // Debouncing for the desktop path lives in main (screenshot-guard.ts
    // coalesces bursts), not here — the renderer can be reloaded mid-burst and
    // would lose its own counter. The web watcher keeps its own for the same
    // reason main keeps one: nothing else is watching.
    if (config.onScreenshotBlocked) {
      return config.onScreenshotBlocked((info) =>
        onAttempt(info?.chord ?? "desktop", info?.recorded ?? false),
      );
    }
    return watchCaptureKeys((chord) => onAttempt(chord, false));
  }, [config, onAttempt]);

  return null;
}
