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
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Phone, Video, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Logo } from "@taskboard/ui";
import {
  onIncomingMeetingAnnounced,
  onIncomingMeetingDismissed,
  requestMeetingJoin,
} from "../lib/MeetingSession";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";

interface Incoming {
  callId: string;
  title: string;
}

/** 12s — inside the requested 10-15s window. Matches an incoming phone call:
 *  long enough to notice and react, short enough not to linger once missed. */
const AUTO_DISMISS_MS = 12_000;

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
      onIncomingMeetingAnnounced((callId, title) => {
        if (seenRef.current.has(callId)) return;
        seenRef.current.add(callId);
        setIncoming({ callId, title });
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

  // The Electron popup window's own Video/Voice click (main/meeting-invite-
  // manager.ts's window has no React Query / MeetingSession context of its
  // own — it's a separate BrowserWindow) comes back here rather than being
  // handled in desktop's main.tsx directly, so there is exactly one place
  // that knows "joining a meeting means requestMeetingJoin", on both
  // platforms. Mounted unconditionally (not inside the `!incoming` guard
  // below) since the popup window can outlive this component's own
  // `incoming` state — it has its own 12s auto-dismiss timer, not this one's.
  useEffect(() => config.onMeetingInviteAction?.(requestMeetingJoin), [config]);

  // Auto-dismiss with no interaction. Re-armed only when `incoming` actually
  // changes identity — which, per the dedup above, means a genuinely new
  // invite, not a repeat announcement of the one already on screen.
  useEffect(() => {
    if (!incoming) return;
    const timer = setTimeout(() => setIncoming(null), AUTO_DISMISS_MS);
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
  const organizer = call?.participants.find((p) => p.role === "HOST")?.username ?? "";

  // Electron: hand off to the always-on-top popup window instead of
  // rendering here. Called again once `organizer` resolves — the manager
  // updates the SAME window's content rather than opening a second one, so
  // the popup can appear instantly (title only) and fill in the organizer a
  // moment later, instead of waiting on the extra round trip.
  useEffect(() => {
    if (!incoming || !config.showMeetingInvitePopup) return;
    config.showMeetingInvitePopup(incoming.callId, incoming.title || t("incomingNotice.untitledMeeting"), organizer);
  }, [incoming, organizer, config, t]);

  if (!incoming || config.showMeetingInvitePopup) return null;

  const dismiss = () => setIncoming(null);
  const join = (media: "video" | "voice") => {
    requestMeetingJoin(incoming.callId, media);
    dismiss();
  };

  return (
    <div
      role="alertdialog"
      aria-label={t("incomingNotice.ariaLabel", { title: incoming.title })}
      className="fixed bottom-4 right-4 z-[150] w-60 rounded-2xl bg-surface p-4 shadow-widget ring-1 ring-border"
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <Logo size={30} />
        {/* Falls back defensively even though every caller (queryBridge's
            meetingTitle) already supplies a non-empty title — this is the
            last line stopping a blank/undefined popup, not the first. */}
        <div className="line-clamp-2 text-sm font-semibold text-fg">
          {incoming.title || t("incomingNotice.untitledMeeting")}
        </div>
        {organizer && (
          <div className="text-xs text-muted">{t("incomingNotice.hostedBy", { organizer })}</div>
        )}
      </div>
      <div className="mt-4 flex items-center justify-center gap-5">
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
        <NoticeAction
          icon={<X size={18} />}
          label={t("incomingNotice.leave")}
          title={t("common:buttons.dismiss")}
          tone="danger"
          onClick={dismiss}
        />
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
