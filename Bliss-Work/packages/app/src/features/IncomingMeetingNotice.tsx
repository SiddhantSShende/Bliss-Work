/**
 * The incoming-meeting popup: BlissWork logo, meeting title, Video/Voice/Leave.
 *
 * Replaces the sonner toast that used to fire for call.started/call.waiting/
 * call.ring (see lib/queryBridge's announceIncomingMeeting call sites) with a
 * small, theme-matched card. Compact and non-blocking by design — modeled on
 * MeetingHost's own RejoinPrompt, not on CallUI's full-screen Backdrop for a
 * direct-call ring, since a meeting invite must never take over the app.
 *
 * Themed for free: every colour below (`bg-surface`, `text-fg`, `ring-border`,
 * `bg-accent-soft`, `text-danger`, …) resolves through the CSS custom
 * properties `packages/ui/src/theme.css` defines per family/mode, the exact
 * same tokens the rest of the app uses — so this automatically matches
 * whichever theme (Default/Rose/Blue/Purple/Teal, light or dark) is active on
 * <html>, on both web and the Electron desktop shell, with nothing
 * theme-specific written here.
 *
 * Mounted once, in MeetingHost, above the router — same reasoning as
 * RejoinPrompt: an invite can arrive on any screen, including mid-meeting.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Phone, Video, X } from "lucide-react";
import { Logo } from "@taskboard/ui";
import { onIncomingMeetingAnnounced, requestMeetingJoin } from "../lib/MeetingSession";

interface Incoming {
  callId: string;
  title: string;
}

export function IncomingMeetingNotice() {
  const [incoming, setIncoming] = useState<Incoming | null>(null);

  useEffect(
    () =>
      onIncomingMeetingAnnounced((callId, title) => {
        // Same meeting already showing: leave it alone rather than replace or
        // stack a second card for an event that just repeats what is already
        // on screen (call.started and call.waiting can both fire for one
        // call in quick succession).
        setIncoming((current) => (current?.callId === callId ? current : { callId, title }));
      }),
    [],
  );

  if (!incoming) return null;

  const dismiss = () => setIncoming(null);
  const join = (media: "video" | "voice") => {
    requestMeetingJoin(incoming.callId, media);
    dismiss();
  };

  return (
    <div
      role="alertdialog"
      aria-label={`Incoming meeting: ${incoming.title}`}
      className="fixed bottom-4 right-4 z-[150] w-60 rounded-2xl bg-surface p-4 shadow-widget ring-1 ring-border"
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <Logo size={30} />
        {/* Falls back defensively even though every caller (queryBridge's
            meetingTitle) already supplies a non-empty title — this is the
            last line stopping a blank/undefined popup, not the first. */}
        <div className="line-clamp-2 text-sm font-semibold text-fg">{incoming.title || "Meeting"}</div>
      </div>
      <div className="mt-4 flex items-center justify-center gap-5">
        <NoticeAction
          icon={<Video size={18} />}
          label="Video"
          title="Join with camera on"
          tone="accent"
          onClick={() => join("video")}
        />
        <NoticeAction
          icon={<Phone size={18} />}
          label="Voice"
          title="Join with voice only"
          tone="accent"
          onClick={() => join("voice")}
        />
        <NoticeAction icon={<X size={18} />} label="Leave" title="Dismiss" tone="danger" onClick={dismiss} />
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
