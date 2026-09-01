import { useEffect, useState } from "react";
import { Mic, MicOff, PhoneOff } from "lucide-react";
import { useRuntime } from "../lib/runtime";
import { useCallDuration } from "../lib/callTimer";
import type { MeetingWindowStatus } from "../platform";

/**
 * The main window's own view of a meeting running in its separate window
 * (see main/meeting-window-manager.ts) — title, elapsed time, mic state, and
 * a hang-up button. No video: LiveKit `Track` objects live in the OTHER
 * window's renderer process and cannot cross the boundary — see
 * useMeetingPiP's own note on why Picture-in-Picture needs no such bridge
 * (it stays inside the SAME renderer that owns the track; this bar is a
 * different problem entirely). Renders nothing unless Electron has actually
 * told us a meeting is running elsewhere.
 */
export function MeetingWindowStatusBar() {
  const { config } = useRuntime();
  const [status, setStatus] = useState<MeetingWindowStatus | null>(null);

  useEffect(() => {
    if (!config.onMeetingWindowStatus) return;
    return config.onMeetingWindowStatus(setStatus);
  }, [config]);

  useEffect(() => {
    if (!config.onMeetingWindowClosed) return;
    return config.onMeetingWindowClosed((callId) => {
      setStatus((s) => (s?.callId === callId ? null : s));
    });
  }, [config]);

  const duration = useCallDuration(status?.startedAt);

  if (!status) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-[90] flex -translate-x-1/2 items-center gap-3 rounded-full border border-border bg-surface/95 px-4 py-2 shadow-card backdrop-blur">
      <span className="max-w-[12rem] truncate text-sm font-medium text-fg">{status.title}</span>
      {duration && <span className="text-xs text-muted">{duration}</span>}
      {status.micOn ? (
        <Mic size={14} className="text-fg" aria-label="Microphone on" />
      ) : (
        <MicOff size={14} className="text-muted" aria-label="Microphone off" />
      )}
      <button
        type="button"
        onClick={() => config.hangUpMeetingWindow?.(status.callId)}
        title="Leave meeting"
        aria-label="Leave meeting"
        className="flex h-7 w-7 items-center justify-center rounded-full bg-danger text-white transition-colors hover:brightness-110"
      >
        <PhoneOff size={13} />
      </button>
    </div>
  );
}
