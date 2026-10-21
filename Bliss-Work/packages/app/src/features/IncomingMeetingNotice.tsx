/**
 * The incoming-meeting popup: BlissWork logo, meeting title, organizer,
 * Video/Voice/Leave.
 *
 * ── One popup, never two ─────────────────────────────────────────────────────
 * On Electron this hands off to a real, always-on-top OS window (see
 * PlatformConfig.showMeetingInvitePopup / main/meeting-invite-manager.ts) and
 * renders NOTHING itself — that window works whether or not BlissWork's own
 * window is focused or even visible, which an in-page card cannot. Web has no
 * such capability, so it keeps the in-page card as its only option. Each
 * platform therefore has exactly ONE active popup mechanism; there is no
 * scenario where both could show for the same invite.
 *
 * Deduping the SAME meeting announced more than once (call.started AND
 * call.waiting AND call.ring can all fire for one call in quick succession)
 * happens in state: `setIncoming` below only ever replaces the current card
 * for a genuinely DIFFERENT callId, so a repeat announcement for the one
 * already showing is a no-op — see the dedup note on `onIncomingMeetingAnnounced`
 * call sites in lib/queryBridge.
 *
 * Auto-dismisses after AUTO_DISMISS_MS with no interaction, same as a phone's
 * own incoming-call screen — an invite nobody answers should not sit on
 * screen forever.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Phone, Video, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Logo } from "@taskboard/ui";
import {
  type AdhocIncoming,
  onIncomingMeetingAnnounced,
  onIncomingMeetingDismissed,
  requestMeetingJoin,
} from "../lib/MeetingSession";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { createRingtone } from "../lib/ringtone";
import { useUserLabels } from "../lib/userLabel";

interface Incoming {
  callId: string;
  title: string;
  /** Set when this is an ad-hoc call somebody was added to: worded as a call,
   *  and there is no organiser to name. */
  adhoc?: AdhocIncoming;
  /** Set when a call.ring has actually fired for this invite — meaning it has
   *  a real server-side deadline and a real Decline, not just a plain FYI
   *  that a meeting started (call.started/call.waiting). An ad-hoc ring is
   *  always `ringing`; a MEETING/CHANNEL invite starts as a plain FYI and is
   *  upgraded in place the moment its own call.ring arrives — see the
   *  announced-listener below, which never lets this regress back to false. */
  ringing?: boolean;
}

/** 12s — inside the requested 10-15s window. Matches an incoming phone call:
 *  long enough to notice and react, short enough not to linger once missed. */
const AUTO_DISMISS_MS = 12_000;

/** Deadline for the ring server-side (store.DirectRingTimeout /
 *  AdditionalInviteRingTimeout, messaging-svc) — the longest a genuinely
 *  ad-hoc card should ever need its own fallback timer for; the sweeper that
 *  enforces it resolves within ~2s, and queryBridge's onIncomingMeetingDismissed
 *  normally clears the card well before this fires at all. Kept only as a
 *  backstop for a dropped/delayed event, not as the card's primary way out —
 *  see the module doc and AUTO_DISMISS_MS above for the non-adhoc card, which
 *  keeps its own, much shorter, blind timeout exactly as before. */
const ADHOC_RING_BACKSTOP_MS = 35_000;

export function IncomingMeetingNotice() {
  const { t } = useTranslation(["calls", "common"]);
  const { api, config } = useRuntime();
  const [incoming, setIncoming] = useState<Incoming | null>(null);
  // EVERY callId this component has ever shown a card for, not just the one
  // currently on screen. Without this, dismissing (or auto-dismissing) an
  // invite and then a LATER, different event type for that SAME call arriving
  // (call.started, then call.waiting, then call.ring can each fire for one
  // meeting) would read as "nothing showing for this id" and bring the card
  // straight back — the popup reappearing right after being dismissed is
  // worse than the original duplicate-toast bug this replaced.
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(
    () =>
      onIncomingMeetingAnnounced((callId, title, adhoc, ringing) => {
        if (seenRef.current.has(callId)) {
          // A repeat announcement for the card already on screen — except a
          // call.ring landing just after the call.started FYI it rides
          // behind for a MEETING/CHANNEL invite, which upgrades that same
          // card into a real, declinable ring rather than being dropped as
          // a duplicate. Never regresses an already-ringing card back down.
          if (ringing) {
            setIncoming((prev) => (prev && prev.callId === callId && !prev.ringing ? { ...prev, ringing: true } : prev));
          }
          return;
        }
        seenRef.current.add(callId);
        setIncoming({ callId, title, adhoc, ringing });
      }),
    [],
  );

  // Read inside the dismissal listener below without making it a dependency
  // — the effect subscribes once, the same way onMeetingInviteAction does.
  const incomingRef = useRef(incoming);
  incomingRef.current = incoming;

  // The call this card is showing ended, or was answered elsewhere, while it
  // was still on screen (see queryBridge's CallEnded/CallParticipantAdded
  // handling). Without this, nothing cleared the card until its own 12s
  // timer ran out — and on desktop, the Electron popup is alwaysOnTop at
  // "screen-saver" level, so it could sit over a full-screen app for several
  // seconds after the call was already over. A no-op for an event about a
  // DIFFERENT call than the one currently shown.
  useEffect(
    () =>
      onIncomingMeetingDismissed((callId) => {
        if (incomingRef.current?.callId !== callId) return;
        setIncoming(null);
        config.dismissMeetingInvitePopup?.(callId);
      }),
    [config],
  );

  // Ring for as long as a card (meeting invite OR ad-hoc call) is on screen —
  // the same "incoming" voice useCall.tsx plays for a 1:1 DIRECT ring, so a
  // recipient hears the identical tone whichever kind of call is reaching
  // them. Keyed on the callId's identity, not just truthiness, so a genuinely
  // new invite replacing the one on screen restarts the ring rather than
  // silently continuing it. Stops immediately on accept/decline/dismiss or a
  // server-driven resolution — all of those already clear `incoming` via
  // setIncoming/dismiss above — which this effect's cleanup picks up.
  useEffect(() => {
    if (!incoming) return;
    const ring = createRingtone("incoming", () => {
      toast(t("notify.ringtoneMuted"), { description: t("notify.ringtoneMutedDescription") });
    });
    ring.start();
    return () => ring.stop();
  }, [incoming, t]);

  // The Electron popup window's own Video/Voice click (main/meeting-invite-
  // manager.ts's window has no React Query / MeetingSession context of its
  // own — it's a separate BrowserWindow) comes back here rather than being
  // handled in desktop's main.tsx directly, so there is exactly one place
  // that knows "joining a meeting means requestMeetingJoin", on both
  // platforms. Mounted unconditionally (not inside the `!incoming` guard
  // below) since the popup window can outlive this component's own
  // `incoming` state — it has its own 12s auto-dismiss timer, not this one's.
  useEffect(
    () =>
      config.onMeetingInviteAction?.((callId, media) => {
        requestMeetingJoin(callId, media);
        // Unlike the in-page Join buttons below (see `join`), this fires from
        // the Electron popup's own window — a separate BrowserWindow with no
        // access to `dismiss()`. Without clearing `incoming` here too, the
        // ring effect above never tears down: its cleanup only runs when
        // `incoming` changes, and joining through the native popup was the
        // one accept path that never touched it, so the ring kept playing
        // in the renderer after the user had already joined.
        if (incomingRef.current?.callId === callId) setIncoming(null);
      }),
    [config],
  );

  /** Explicit "no" to an ad-hoc ring. The card is dismissed immediately,
   *  while a failed request is surfaced so the user knows the other person
   *  may still be ringing. */
  const declineCall = useCallback(
    (callId: string) => {
      void api.declineCall(callId).catch(() => {
        toast.error(t("incomingNotice.declineFailed"));
      });
    },
    [api, t],
  );

  // Same idea for the popup's Decline — it has no api/React Query of its own
  // either, so the actual POST happens here, same as above.
  useEffect(() => config.onMeetingInviteDeclined?.(declineCall), [config, declineCall]);

  // Auto-dismiss with no interaction. Re-armed only when `incoming` actually
  // changes identity — which, per the dedup above, means a genuinely new
  // invite, not a repeat announcement of the one already on screen.
  //
  // An ad-hoc ring is DIFFERENT: the thing that actually resolves it is the
  // server (a decline, a timeout the ~2s ring sweeper catches, or the call
  // being answered/ended elsewhere — see onIncomingMeetingDismissed above,
  // fed by queryBridge's call.declined/call.no_answer/call.missed/call.ended
  // handling), never a blind client-side clock. This timer is kept only as a
  // backstop for a dropped event, generous enough (comfortably past the
  // server's own 30s/20s ring deadline) that it should essentially never be
  // the thing that actually fires. A genuine meeting/channel invite keeps its
  // original, much shorter AUTO_DISMISS_MS — nothing server-side resolves
  // those, so the blind timeout IS the mechanism there, unchanged.
  useEffect(() => {
    if (!incoming) return;
    const ms = incoming.ringing ? ADHOC_RING_BACKSTOP_MS : AUTO_DISMISS_MS;
    const timer = setTimeout(() => setIncoming(null), ms);
    return () => clearTimeout(timer);
  }, [incoming]);

  // Organizer — resolved from the call's own roster (the HOST participant),
  // the same field CallRoom's own header reads. Reuses api.call()/qk.call, so
  // this also warms the cache MeetingHost's join flow fetches from moments
  // later rather than costing a second request. Falls back to "" (rendered
  // as no organizer line) rather than blocking the popup on this — the title
  // is what a person decides from; the organizer is a nice-to-have.
  const { data: call } = useQuery({
    queryKey: qk.call(incoming?.callId ?? ""),
    queryFn: () => api.call(incoming!.callId),
    enabled: !!incoming,
    staleTime: 60_000,
  });
  const adhoc = !!incoming?.adhoc;
  const { nameOf } = useUserLabels();
  const host = adhoc ? undefined : call?.participants.find((p) => p.role === "HOST");
  const organizer = host ? nameOf(host.userId, host.username) : "";
  // "X added you to a conference call" when the server named X, else just what it is.
  const heading = !incoming
    ? ""
    : adhoc
      ? incoming.adhoc?.actorName
        ? t("incomingNotice.addedYou", { name: incoming.adhoc.actorName })
        : t("incomingNotice.conferenceTitle")
      : incoming.title || t("incomingNotice.untitledMeeting");

  // Electron: hand off to the always-on-top popup window instead of
  // rendering here. Called again once `organizer` resolves — the manager
  // updates the SAME window's content rather than opening a second one, so
  // the popup can appear instantly (title only) and fill in the organizer a
  // moment later, instead of waiting on the extra round trip.
  const ringing = !!incoming?.ringing;
  useEffect(() => {
    if (!incoming || !config.showMeetingInvitePopup) return;
    config.showMeetingInvitePopup(
      incoming.callId,
      heading,
      organizer,
      adhoc,
      adhoc ? (call?.media === "audio" ? "voice" : "video") : undefined,
      ringing,
    );
  }, [incoming, heading, organizer, adhoc, ringing, call?.media, config]);

  if (!incoming || config.showMeetingInvitePopup) return null;

  const dismiss = () => setIncoming(null);
  const join = (media: "video" | "voice") => {
    requestMeetingJoin(incoming.callId, media);
    dismiss();
  };
  // A real ring — ad-hoc, or a MEETING/CHANNEL invite once its own call.ring
  // has arrived — gets a real "no" told to the server, so the inviter's/
  // organizer's side reads "declined" rather than silently ringing out (see
  // CallRoom's callResolution). A plain FYI with no ring behind it yet has
  // no invitation to decline, so it keeps a local-only dismiss.
  const decline = () => {
    declineCall(incoming.callId);
    dismiss();
  };
  // A call's own type was fixed when it was placed — the recipient accepts
  // or rejects it, never picks voice vs. video themselves (that would risk
  // silently turning a video call into a voice one, or vice versa). `call`
  // is the same roster fetch already warmed above; it is near-instant from
  // cache in practice, but fall back to video rather than block Accept on
  // the request if it is somehow still in flight.
  const acceptCall = () => join(call?.media === "audio" ? "voice" : "video");

  return (
    <div
      role="alertdialog"
      aria-label={
        adhoc ? t("incomingNotice.ariaLabelCall", { title: heading }) : t("incomingNotice.ariaLabel", { title: incoming.title })
      }
      className="fixed bottom-4 right-4 z-[var(--z-notification)] w-60 rounded-2xl bg-surface p-4 shadow-widget ring-1 ring-border"
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <Logo size={30} />
        {/* Falls back defensively even though every caller (queryBridge's
            meetingTitle) already supplies a non-empty title — this is the
            last line stopping a blank/undefined popup, not the first. */}
        <div className="line-clamp-2 text-sm font-semibold text-fg">{heading}</div>
        {organizer && (
          <div className="text-xs text-muted">{t("incomingNotice.hostedBy", { organizer })}</div>
        )}
      </div>
      <div className="mt-4 flex items-center justify-center gap-5">
        {adhoc ? (
          // A call rings the recipient with exactly two choices — accept it
          // as placed, or reject it. There is no device picker here: the
          // call's own media type (see acceptCall above) decides what gets
          // initialized once it connects.
          <>
            <NoticeAction
              icon={<Phone size={18} />}
              label={t("incomingNotice.accept")}
              title={t("incomingNotice.accept")}
              tone="accent"
              onClick={acceptCall}
            />
            <NoticeAction
              icon={<X size={18} />}
              label={t("incomingNotice.decline")}
              title={t("incomingNotice.decline")}
              tone="danger"
              onClick={decline}
            />
          </>
        ) : (
          <>
            <NoticeAction
              icon={<Video size={18} />}
              label={t("incomingNotice.video")}
              title={t("incomingNotice.joinWithCamera")}
              tone="accent"
              onClick={() => join("video")}
            />
            <NoticeAction
              icon={<Phone size={18} />}
              label={t("incomingNotice.voice")}
              title={t("incomingNotice.joinVoiceOnly")}
              tone="accent"
              onClick={() => join("voice")}
            />
            {ringing ? (
              // A real invitation is open on the server (ring_expires_at) —
              // Decline tells it "no" rather than merely hiding the card.
              <NoticeAction
                icon={<X size={18} />}
                label={t("incomingNotice.decline")}
                title={t("incomingNotice.decline")}
                tone="danger"
                onClick={decline}
              />
            ) : (
              // No ring behind this card yet (a plain call.started/
              // call.waiting FYI) — nothing to decline, so this only hides
              // the card locally.
              <NoticeAction
                icon={<X size={18} />}
                label={t("incomingNotice.leave")}
                title={t("common:buttons.dismiss")}
                tone="danger"
                onClick={dismiss}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function NoticeAction({
  icon,
  label,
  title,
  tone,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  title: string;
  tone: "accent" | "danger";
  onClick: () => void;
}) {
  const tones = {
    accent: "bg-accent-soft text-accent hover:brightness-95",
    danger: "bg-danger/10 text-danger hover:bg-danger/20",
  };
  return (
    <button type="button" onClick={onClick} title={title} aria-label={title} className="flex flex-col items-center gap-1">
      <span className={`flex h-10 w-10 items-center justify-center rounded-full transition ${tones[tone]}`}>
        {icon}
      </span>
      <span className="text-[11px] font-medium text-muted">{label}</span>
    </button>
  );
}
