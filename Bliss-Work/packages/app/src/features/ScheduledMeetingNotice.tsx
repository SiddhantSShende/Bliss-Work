/**
 * The "meeting scheduled" card: BlissWork mark, a date tile, the meeting title,
 * when, who is hosting, and a Join Meeting button.
 *
 * Replaces the plain `toast("Call scheduled: …")` that queryBridge used to raise
 * for call.scheduled. A scheduling is worth more than four seconds of grey text:
 * it carries a time someone has to act on, and the toast had no way to take them
 * to the meeting.
 *
 * ── A different notice from IncomingMeetingNotice, on purpose ────────────────
 * IncomingMeetingNotice interrupts: a meeting is starting NOW, so it is small,
 * auto-dismisses fast, and on Electron hands off to an always-on-top OS window.
 * This one informs, so it stays in-page, lives longer, and is never mirrored to
 * an OS window — the persisted MEETING_SCHEDULED notification (the bell, and the
 * desktop popup built from it) already reaches someone who is not looking at the
 * app. Both listen for their own window event and never see each other's.
 *
 * One card at a time: a newer scheduling replaces the one on screen. Each event
 * is shown once — see ScheduledMeeting.eventId — so neither a repeat delivery nor
 * a dismissed card coming back is possible for the same event.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { UserRound, Video, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, Logo } from "@taskboard/ui";
import { onIncomingMeetingAnnounced, requestMeetingJoin } from "../lib/MeetingSession";
import { dayLabel, timeLabel } from "../lib/meetingTime";
import { qk } from "../lib/queryKeys";
import { useRuntime } from "../lib/runtime";
import { onScheduledMeetingAnnounced, type ScheduledMeeting } from "../lib/scheduledMeetingNotice";
import { useUserLabels } from "../lib/userLabel";

/** Longer than IncomingMeetingNotice's 12s: this one asks to be read, not
 *  answered, and nobody is being kept waiting on a ring. */
const AUTO_DISMISS_MS = 20_000;

/** How long IncomingMeetingNotice stays up (its own AUTO_DISMISS_MS, which it
 *  does not export) — how long this card keeps out of its way. */
const INCOMING_VISIBLE_MS = 12_000;

const startMs = (iso?: string | null): number => (iso ? new Date(iso).getTime() : NaN);

/** "Today" and "3:00 PM – 3:30 PM", the pieces of the line MeetingPreview prints
 *  as one. The end is optional — a call that named no duration has none — and an
 *  unparseable start yields null so the row is simply left out. Kept apart so
 *  the range can be set unbreakable: a narrow card wraps at the "·", never
 *  between "10:15" and "AM". */
function whenParts(startIso?: string | null, endIso?: string | null): { day: string; range: string } | null {
  const start = startMs(startIso);
  if (!Number.isFinite(start)) return null;
  const end = startMs(endIso);
  return {
    day: dayLabel(start),
    range: Number.isFinite(end) ? `${timeLabel(start)} – ${timeLabel(end)}` : timeLabel(start),
  };
}

/** A calendar-page tile (month over day) — or the video mark for a call with no
 *  date — so the card says "meeting, on this day" before a word is read. */
function DateTile({ startIso }: { startIso?: string | null }) {
  const { i18n } = useTranslation();
  const start = startMs(startIso);
  return (
    <div
      aria-hidden
      className="flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-2xl bg-gradient-to-br from-brand-from via-brand-mid to-brand-to text-accent-fg shadow-soft"
    >
      {Number.isFinite(start) ? (
        <>
          <span className="text-[10px] font-bold uppercase leading-none tracking-wider">
            {new Date(start).toLocaleDateString(i18n.language, { month: "short" })}
          </span>
          <span className="mt-0.5 text-xl font-bold leading-none">{new Date(start).getDate()}</span>
        </>
      ) : (
        <Video size={24} />
      )}
    </div>
  );
}

export function ScheduledMeetingNotice() {
  const { t } = useTranslation("calls");
  const { api, config } = useRuntime();
  const [notice, setNotice] = useState<ScheduledMeeting | null>(null);
  // Whether an IncomingMeetingNotice card is (probably) sitting in the same
  // corner right now. See the effect below.
  const [yielding, setYielding] = useState(false);
  // EVERY event this card has shown, not just the one on screen: dismissing it
  // must not let the same event bring it back.
  const seenRef = useRef<Set<string>>(new Set());
  // Same rule IncomingMeetingNotice applies to its own callIds, so this only
  // yields for a card that can actually appear.
  const incomingSeenRef = useRef<Set<string>>(new Set());

  useEffect(
    () =>
      onScheduledMeetingAnnounced((next) => {
        if (seenRef.current.has(next.eventId)) return;
        seenRef.current.add(next.eventId);
        setNotice(next);
      }),
    [],
  );

  // Re-armed per notice, so a newer scheduling gets its own full window.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // Both notices live in the bottom-right corner, and the one for a meeting
  // starting NOW is drawn on top — it would hide this card's Join button. This
  // card cannot see that one's state, only its announcement, so it moves up
  // for as long as that card stays up by default. If the person dismisses it
  // sooner the lift lingers harmlessly; it never leaves this card covered.
  // Electron shows that popup in its own OS window, so there is nothing to
  // clear there.
  useEffect(
    () =>
      onIncomingMeetingAnnounced((callId) => {
        if (config.showMeetingInvitePopup || incomingSeenRef.current.has(callId)) return;
        incomingSeenRef.current.add(callId);
        setYielding(true);
      }),
    [config],
  );
  useEffect(() => {
    if (!yielding) return;
    const timer = setTimeout(() => setYielding(false), INCOMING_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [yielding]);

  // Host and end time come from the call row — the event carries neither. The
  // same read (and cache entry) IncomingMeetingNotice and the join flow make.
  // Optional: if it fails, the card is complete without them, so no retry and
  // no error surface.
  const { data: call } = useQuery({
    queryKey: qk.call(notice?.callId ?? ""),
    queryFn: () => api.call(notice!.callId),
    enabled: !!notice,
    staleTime: 60_000,
    retry: false,
  });

  const { nameOf } = useUserLabels();

  if (!notice) return null;

  const title = notice.title || t("scheduledNotice.untitledMeeting");
  const when = whenParts(notice.scheduledAt, call?.endsAt);
  const host = call?.participants.find((p) => p.role === "HOST");
  const organizer = host ? nameOf(host.userId, host.username) : "";
  const dismiss = () => setNotice(null);
  const join = () => {
    requestMeetingJoin(notice.callId);
    dismiss();
  };

  return (
    <div
      role="alertdialog"
      aria-label={t("scheduledNotice.ariaLabel", { title })}
      className={`fixed right-4 z-[var(--z-notification)] w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-2xl bg-surface shadow-widget ring-1 ring-accent/25 transition-[bottom] duration-200 ${
        yielding ? "bottom-[14rem]" : "bottom-4"
      }`}
    >
      <div className="relative flex items-center gap-2.5 overflow-hidden bg-gradient-to-br from-brand-from via-brand-mid to-brand-to px-4 py-3 text-accent-fg">
        {/* A soft highlight, so the header reads as a lit surface and not a flat bar. */}
        <span aria-hidden className="pointer-events-none absolute -right-6 -top-10 h-28 w-28 rounded-full bg-white/15" />
        <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/95 shadow-soft">
          <Logo size={22} />
        </span>
        <span className="relative min-w-0 flex-1 truncate text-[13px] font-bold uppercase tracking-wide">
          {t("scheduledNotice.heading")}
        </span>
        <button
          type="button"
          onClick={dismiss}
          title={t("scheduledNotice.dismiss")}
          aria-label={t("scheduledNotice.dismiss")}
          className="relative shrink-0 rounded-lg p-1 transition-colors hover:bg-white/20"
        >
          <X size={16} />
        </button>
      </div>
      <div className="flex flex-col gap-4 bg-gradient-to-b from-accent-soft/60 to-surface p-4">
        <div className="flex items-center gap-3">
          <DateTile startIso={notice.scheduledAt} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="line-clamp-2 break-words text-lg font-semibold leading-snug text-fg">{title}</div>
            {when && (
              <div className="text-sm font-medium text-fg">
                {when.day} · <span className="whitespace-nowrap">{when.range}</span>
              </div>
            )}
            {organizer && (
              <div className="mt-0.5 flex items-center gap-1.5 text-[13px] text-muted">
                <UserRound size={13} className="shrink-0 text-accent" aria-hidden />
                <span className="truncate">{t("scheduledNotice.hostedBy", { organizer })}</span>
              </div>
            )}
          </div>
        </div>
        <Button size="lg" className="w-full" onClick={join}>
          <Video size={17} aria-hidden />
          {t("scheduledNotice.join")}
        </Button>
      </div>
    </div>
  );
}
