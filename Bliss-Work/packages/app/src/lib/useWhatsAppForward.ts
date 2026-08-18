import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useRuntime } from "./runtime";
import { qk } from "./queryBridge";

/**
 * Record that a message was handed to WhatsApp — but only once the user has
 * actually been away and come back.
 *
 * This does NOT open WhatsApp. The link is a real anchor in the message menu
 * (MessageActions) so the browser navigates on its own — a scripted open after
 * an await is what popup blockers exist to stop. The click only ARMS this hook;
 * the POST happens on return.
 *
 * ── Why the write is deferred ────────────────────────────────────────────────
 * Writing the audit pill on the click was a claim we had not earned. A blocked
 * popup, a missing WhatsApp install, or a user who lands on the login wall and
 * turns straight back all produced the same pill in the thread as a real
 * forward. Arming on the click and writing on the return means the thread stays
 * clean for the trips that never happened.
 *
 * ── What this can and cannot observe ─────────────────────────────────────────
 * It can observe that this page lost the foreground and later regained it, and
 * how long that took. It CANNOT observe whether WhatsApp was logged in, whether
 * Send was pressed, or who was chosen — different app, different origin, and
 * wa.me has no callback of any kind. A dwell of at least MIN_AWAY_MS is the
 * honest proxy available, and it is a proxy, not proof: the toast and the pill
 * are both worded as a handoff, never as a delivery.
 *
 * No phone number is sent, because none is captured. The link is
 * `wa.me/?text=…`, so WhatsApp shows its own contact chooser and the recipient
 * is picked there, out of our sight — see waShareLink for why that trade is the
 * right one.
 */

/**
 * How long the page must stay out of the foreground before a return counts as
 * "they went to WhatsApp".
 *
 * Below this is an instant bounce: a blocked popup, a tab that failed to load,
 * or a user who saw the WhatsApp login wall and came straight back. Those are
 * exactly the trips that must leave no trace. Above it we still cannot prove a
 * send happened — see the note above.
 */
const MIN_AWAY_MS = 2500;

export function useWhatsAppForward() {
  const { api } = useRuntime();
  const qc = useQueryClient();

  /**
   * Armed forwards, messageId → clientMsgId. A Map rather than a single slot so
   * two different messages armed back to back both survive, and rather than a
   * plain Set so the id is minted ONCE per message: the menu can be reopened
   * and clicked again, and a second click is the same forward, not a new one.
   * The server dedupes on clientMsgId, but only if we do not mint a fresh one.
   */
  const armed = useRef(new Map<string, string>());
  /** When the page left the foreground, or null while it is in front. */
  const awayAt = useRef<number | null>(null);

  const flush = useCallback(
    async (entries: Array<[string, string]>) => {
      const results = await Promise.all(
        entries.map(async ([messageId, clientMsgId]) => {
          try {
            await api.forwardMessageLink(messageId, undefined, undefined, clientMsgId);
            return true;
          } catch {
            return false;
          }
        }),
      );
      if (results.some(Boolean)) {
        // queryBridge drops the WS echo of our own message.created (the composer
        // renders those optimistically), and this system entry never went
        // through the composer — so nothing refreshes unless we ask.
        void qc.invalidateQueries({ queryKey: qk.conversations });
        void qc.invalidateQueries({ queryKey: ["messages"] });
        void qc.invalidateQueries({ queryKey: ["channelMessages"] });
        toast.success("Forwarded through WhatsApp", {
          description: "You picked the recipient in WhatsApp, so this chat records the handoff only.",
        });
      }
      if (results.some((ok) => !ok)) {
        toast.error("Couldn't log the forward", {
          description: "WhatsApp still opened — it just isn't recorded in this chat.",
        });
      }
    },
    [api, qc],
  );

  useEffect(() => {
    const leave = () => {
      if (armed.current.size > 0 && awayAt.current === null) awayAt.current = Date.now();
    };
    const back = () => {
      if (awayAt.current === null || armed.current.size === 0) return;
      const away = Date.now() - awayAt.current;
      awayAt.current = null;
      const entries = [...armed.current.entries()];
      // Disarm either way: the FIRST return decides. Staying armed after a short
      // bounce would let any later unrelated app-switch write the pill, which
      // trades a missing record for a false one. Under-recording is the safe
      // direction here — the pill is the original author's evidence that their
      // message left, and inventing one is worse than lacking one.
      armed.current.clear();
      if (away < MIN_AWAY_MS) return;
      void flush(entries);
    };

    // Two signals, because neither covers both hosts. A browser opening wa.me in
    // a new tab backgrounds this one, which fires visibilitychange. Electron
    // hands the link to the system browser via shell.openExternal and the
    // renderer usually stays "visible", so only the window blur fires. Whichever
    // arrives first wins; the guards above make the second a no-op.
    const onVisibility = () => (document.hidden ? leave() : back());
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", leave);
    window.addEventListener("focus", back);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", leave);
      window.removeEventListener("focus", back);
    };
  }, [flush]);

  /** Arm on the click that navigates. Nothing is written until the user returns. */
  return useCallback((messageId: string) => {
    if (!armed.current.has(messageId)) armed.current.set(messageId, crypto.randomUUID());
  }, []);
}
