/**
 * One participant, as a tile.
 *
 * Lifted out of CallRoom when the room grew a pinned stage and a paged member
 * area: the same tile now renders at three sizes, and the media binding below
 * is the part that must not be duplicated to achieve that.
 *
 * The video element is attached imperatively because a MediaStreamTrack is not
 * a React value — it is a live handle that has to be bound to the element and
 * unbound when it changes, or the tile keeps rendering a track that has since
 * been republished.
 */
import { useEffect, useRef } from "react";
import { Hand, MicOff, Monitor, Pin, PinOff, ScreenShare } from "lucide-react";
import { cn } from "@taskboard/ui";
import type { RoomParticipant } from "../lib/useCallRoom";

/** How big this tile is, which decides what it has room to say. */
type TileSize = "stage" | "grid" | "strip";

const NAME_TEXT: Record<TileSize, string> = {
  stage: "text-sm",
  grid: "text-xs",
  strip: "text-[10px]",
};

const AVATAR: Record<TileSize, string> = {
  stage: "h-24 w-24 text-3xl",
  grid: "h-14 w-14 text-base",
  strip: "h-9 w-9 text-xs",
};

export function CallTile({
  p,
  size = "grid",
  pinned = false,
  active = false,
  handRaised = false,
  onTogglePin,
}: {
  p: RoomParticipant;
  size?: TileSize;
  pinned?: boolean;
  /**
   * This tile is the one everyone is currently looking at — the active
   * speaker or the viewer's own pin — wherever it's shown: the stage itself,
   * or its matching thumbnail in a filmstrip or list. Forces the highlight
   * ring (and, on the stage, a glow) on regardless of this instant's raw
   * `p.speaking` value, so it doesn't flicker as they pause between words.
   */
  active?: boolean;
  handRaised?: boolean;
  /** Omitted where pinning makes no sense (the stage's own tile has its own
   *  unpin control). */
  onTogglePin?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // A shared screen wins the tile: it is what the room is looking at, and it is
  // the one picture that is useless cropped, so it is letterboxed rather than
  // filled.
  const shown = p.sharing ? p.screenTrack : p.videoTrack;
  // Mirrors the condition the <video> element is rendered under, below.
  const showVideo = p.camOn || p.sharing;
  // The sharer's OWN capture, played back to themselves, is a video-feedback
  // loop rather than a picture: "Entire screen" (or a window/tab that includes
  // this app) captures the very tile that is showing the capture, so every
  // frame contains the previous one — a mirror that gets worse, not better,
  // once native Picture-in-Picture puts a second copy on top (see CallRoom's
  // pipTrack, which excludes this same case). A static reminder replaces the
  // live feed instead; everyone else still sees the real thing.
  const selfSharePreview = p.isLocal && p.sharing;

  // ── Why these deps, and not just the track ──────────────────────────────────
  // The <video> element is CONDITIONALLY RENDERED. Turning the camera off
  // unmounts it; turning it back on mounts a NEW one. Neither changes the Track
  // object's identity, so an effect keyed on the track alone did not re-run —
  // and the freshly mounted element was never attached to anything. That is the
  // "pause then resume leaves a blank tile" bug, and it hit remote participants
  // as well as the local one.
  //
  // `showVideo` is what re-runs this after the element remounts (effects run
  // after commit, so the ref points at the new element by then).
  //
  // `streamId` covers the other half: LiveKit can swap the underlying
  // MediaStreamTrack — a camera re-acquired after being stopped — while keeping
  // the same Track wrapper. Without it the element would stay bound to a track
  // that has ended, which also renders as a blank tile.
  const streamId = shown?.mediaStreamTrack?.id;

  useEffect(() => {
    const el = videoRef.current;
    const track = shown;
    if (!el || !track || !showVideo || selfSharePreview) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [shown, showVideo, streamId, selfSharePreview]);

  return (
    <div
      className={cn(
        "group relative h-full min-h-0 w-full overflow-hidden rounded-xl bg-surface-2 ring-2 transition-colors",
        p.speaking || active ? "ring-accent" : "ring-transparent",
        active && size === "stage" && "shadow-[0_0_28px_-6px_var(--color-accent)]",
        pinned && size !== "stage" && !active && "ring-accent/60",
      )}
    >
      {selfSharePreview ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-black px-2 text-center text-white">
          <Monitor size={size === "strip" ? 18 : 28} className="text-red-400" />
          <span className={cn("font-medium", NAME_TEXT[size])}>You're presenting your screen</span>
        </div>
      ) : p.camOn || p.sharing ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          // Muting the local tile is not cosmetic: an unmuted local video
          // element is an echo loop.
          muted={p.isLocal}
          className={cn(
            "h-full w-full",
            p.sharing ? "bg-black object-contain" : "object-cover",
            // Only the local camera is mirrored, so the tile reads naturally to
            // the person looking at themselves — never a remote participant's
            // camera (they see the raw, un-mirrored track LiveKit publishes,
            // same as everyone else in the room), and never a screen share
            // (mirroring text on someone's screen would make it unreadable).
            p.isLocal && !p.sharing && "-scale-x-100",
          )}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <div
            className={cn(
              "flex items-center justify-center rounded-full bg-accent-soft font-semibold text-accent",
              AVATAR[size],
            )}
          >
            {(p.name || "?").slice(0, 2).toUpperCase()}
          </div>
        </div>
      )}

      {/* Pin lives on hover so twelve tiles are not twelve buttons, but it is
          also revealed by keyboard focus — an affordance only a mouse can find
          is one a keyboard user does not have. */}
      {onTogglePin && (
        <button
          type="button"
          onClick={onTogglePin}
          title={pinned ? `Unpin ${p.name}` : `Pin ${p.name}`}
          aria-label={pinned ? `Unpin ${p.name}` : `Pin ${p.name}`}
          aria-pressed={pinned}
          className={cn(
            "absolute right-1.5 top-1.5 rounded-lg bg-black/55 p-1.5 text-white opacity-0 transition",
            "hover:bg-black/75 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
            "group-hover:opacity-100",
            pinned && "opacity-100",
          )}
        >
          {pinned ? <Pin size={13} className="fill-current" /> : <Pin size={13} />}
        </button>
      )}

      {handRaised && (
        <span
          title={`${p.name} has their hand up`}
          className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-lg bg-amber-400 px-1.5 py-1 text-[10px] font-semibold text-amber-950"
        >
          <Hand size={12} />
        </span>
      )}

      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/60 to-transparent px-2 py-1.5">
        <span className={cn("truncate font-medium text-white", NAME_TEXT[size])}>
          {p.name}
          {p.isLocal && " (you)"}
        </span>
        {p.sharing && <ScreenShare size={12} className="shrink-0 text-red-400" />}
        {!p.micOn && <MicOff size={12} className="shrink-0 text-red-400" />}
      </div>
    </div>
  );
}

/** The unpin control the pinned stage carries, so leaving a pin is always one
 *  click away from where the eye already is.
 *
 *  Named for the STAGE rather than for the person on it, because the member
 *  tile's own pin toggle is already "Unpin {name}" — two controls with one
 *  accessible name is a screen reader reading the same button twice. */
export function UnpinButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Unpin ${name} from the main view`}
      aria-label="Unpin the main view"
      className="absolute right-2 top-2 z-10 flex items-center gap-1.5 rounded-lg bg-black/55 px-2 py-1.5 text-[11px] font-medium text-white transition hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
    >
      <PinOff size={13} /> Unpin
    </button>
  );
}
