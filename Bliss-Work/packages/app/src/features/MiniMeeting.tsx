/**
 * The meeting, out of the way but still running.
 *
 * ── What this is for ─────────────────────────────────────────────────────────
 * A meeting is something you are IN while you carry on working — reading the
 * thread it is about, opening the task somebody just mentioned. This is the
 * meeting while that happens: small, always on top, draggable out of the way,
 * and showing the four things you need to know without going back (who is
 * talking, how long it has been, whether your microphone is open, and whether
 * anybody has said something in the chat).
 *
 * ── It is a view, not a session ──────────────────────────────────────────────
 * Nothing here owns the meeting. The room stays mounted and connected behind
 * it — hidden, not unmounted, which is the whole reason the call survives
 * (see lib/MeetingSession). So this holds no media, no participant state and no
 * connection; it renders what CallRoom hands it and calls back for the rest.
 *
 * The preview deliberately carries NO audio (`withAudio={false}`): the room
 * behind it is still playing everybody, and a second sink on the same track is
 * the same voice twice.
 *
 * ── The drag ─────────────────────────────────────────────────────────────────
 * Same three-phase pointer state machine as BrowserStickies, for the same
 * reasons: a threshold so buttons inside the card still take their clicks, a
 * `[data-no-drag]` opt-out on every control, pointer capture so a fast drag
 * does not escape the element, and clamping so the window can never be dragged
 * off-screen or stranded by a resize.
 */
import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Maximize2,
  MessageSquare,
  Mic,
  MicOff,
  PhoneOff,
  Users,
  Video,
  VideoOff,
} from "lucide-react";
import { useCallDuration } from "../lib/callTimer";
import type { RoomParticipant, RoomStatus } from "../lib/useCallRoom";
import { CallTile } from "./CallTile";

const CARD_W = 260;
const CARD_H = 208;
const PAD = 12;
/** Movement below this is a click, not a drag. */
const DRAG_THRESHOLD = 4;
const POSITION_KEY = "tb.mini-meeting.v1";

type Point = { x: number; y: number };

function readPosition(): Point | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(POSITION_KEY);
    return raw ? (JSON.parse(raw) as Point) : null;
  } catch {
    return null;
  }
}

function writePosition(pos: Point): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(POSITION_KEY, JSON.stringify(pos));
  } catch {
    /* private browsing / quota — the window simply starts in its corner */
  }
}

/** Out of the way by default: the bottom-right corner, above the toasts. */
function defaultPosition(): Point {
  if (typeof window === "undefined") return { x: PAD, y: PAD };
  return {
    x: Math.max(PAD, window.innerWidth - CARD_W - PAD),
    y: Math.max(PAD, window.innerHeight - CARD_H - PAD * 6),
  };
}

function clampToViewport(pos: Point): Point {
  if (typeof window === "undefined") return pos;
  return {
    x: Math.min(Math.max(0, pos.x), Math.max(0, window.innerWidth - CARD_W)),
    y: Math.min(Math.max(0, pos.y), Math.max(0, window.innerHeight - CARD_H)),
  };
}

export function MiniMeeting({
  title,
  stage,
  participantCount,
  status,
  micOn,
  camOn,
  unread,
  connectedAt,
  onToggleMic,
  onToggleCam,
  onRestore,
  onLeave,
}: {
  title: string;
  /** Whoever the room is looking at — the active speaker, or a manual pin. */
  stage: RoomParticipant | undefined;
  participantCount: number;
  status: RoomStatus;
  micOn: boolean;
  camOn: boolean;
  unread: number;
  connectedAt?: number;
  onToggleMic: () => void;
  onToggleCam: () => void;
  onRestore: () => void;
  onLeave: () => void;
}) {
  const [pos, setPos] = useState<Point>(() => clampToViewport(readPosition() ?? defaultPosition()));
  const duration = useCallDuration(connectedAt);

  // A window dragged to the right edge and then a narrowed viewport is a window
  // that is no longer reachable.
  useEffect(() => {
    const onResize = () => setPos((p) => clampToViewport(p));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const drag = useRef<{
    phase: "idle" | "press" | "drag";
    startX: number;
    startY: number;
    origin: Point;
    pointerId: number;
  } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as Element).closest("[data-no-drag]")) return;
    drag.current = {
      phase: "press",
      startX: e.clientX,
      startY: e.clientY,
      origin: pos,
      pointerId: e.pointerId,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (d.phase === "press") {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      d.phase = "drag";
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* capture may be denied — drag still works */
      }
    }
    setPos(clampToViewport({ x: d.origin.x + dx, y: d.origin.y + dy }));
  };

  const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (d.phase === "drag") {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      writePosition(pos);
    }
    drag.current = null;
  };

  const connecting = status === "connecting" || status === "reconnecting";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.94 }}
      transition={{ type: "spring", stiffness: 380, damping: 30 }}
      role="complementary"
      aria-label={`${title} — meeting in progress`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        width: CARD_W,
        touchAction: "none",
        userSelect: "none",
      }}
      // Above every panel and modal, below nothing: a meeting you are in is the
      // one thing that must never end up behind something.
      className="pointer-events-auto z-[150] overflow-hidden rounded-2xl bg-surface shadow-widget ring-1 ring-border"
    >
      <header className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold text-fg">{title}</div>
          <div className="flex items-center gap-2 text-[10px] text-muted">
            <span className="inline-flex items-center gap-1">
              <Users size={9} /> {participantCount}
            </span>
            {connecting ? (
              <span className="text-warning">
                {status === "reconnecting" ? "Reconnecting…" : "Connecting…"}
              </span>
            ) : (
              <span className="tabular-nums">{duration}</span>
            )}
          </div>
        </div>
      </header>

      {/* Click anywhere on the picture to come back — the whole point of a
          minimised window is that returning is one gesture. */}
      <button
        type="button"
        data-no-drag
        onClick={onRestore}
        title="Back to the meeting"
        aria-label="Back to the meeting"
        className="group relative block h-28 w-full bg-surface-2"
      >
        {stage ? (
          <CallTile p={stage} size="strip" withAudio={false} />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[11px] text-muted">
            {connecting ? "Connecting…" : "Nobody is speaking"}
          </div>
        )}
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-opacity group-hover:bg-black/40 group-hover:opacity-100 group-focus-visible:bg-black/40 group-focus-visible:opacity-100">
          <Maximize2 size={18} className="text-white" />
        </span>
      </button>

      <div className="flex items-center justify-between gap-1 px-2 py-2">
        <div className="flex items-center gap-1">
          <MiniButton
            title={micOn ? "Mute" : "Unmute"}
            onClick={onToggleMic}
            danger={!micOn}
          >
            {micOn ? <Mic size={14} /> : <MicOff size={14} />}
          </MiniButton>
          <MiniButton
            title={camOn ? "Turn camera off" : "Turn camera on"}
            onClick={onToggleCam}
            danger={!camOn}
          >
            {camOn ? <Video size={14} /> : <VideoOff size={14} />}
          </MiniButton>
          {/* Unread chat, where the eye already is. Restoring is what reads it,
              so this is a signal rather than a control. */}
          {unread > 0 && (
            <span
              title={`${unread} new chat ${unread === 1 ? "message" : "messages"}`}
              className="inline-flex items-center gap-1 rounded-lg bg-danger/10 px-1.5 py-1 text-[10px] font-semibold text-danger"
            >
              <MessageSquare size={12} />
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          <MiniButton title="Back to the meeting" onClick={onRestore}>
            <Maximize2 size={14} />
          </MiniButton>
          <MiniButton title="Leave the meeting" onClick={onLeave} solidDanger>
            <PhoneOff size={14} />
          </MiniButton>
        </div>
      </div>
    </motion.div>
  );
}

function MiniButton({
  title,
  onClick,
  danger = false,
  solidDanger = false,
  children,
}: {
  title: string;
  onClick: () => void;
  danger?: boolean;
  solidDanger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      // Every control opts out of the drag, or pressing one while the pointer
      // wobbles four pixels moves the window instead.
      data-no-drag
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
        solidDanger
          ? "bg-danger text-white hover:brightness-90"
          : danger
            ? "bg-danger/10 text-danger hover:bg-danger/20"
            : "text-muted hover:bg-surface-2 hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}
