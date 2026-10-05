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
import { useTranslation } from "react-i18next";
import { cn } from "@taskboard/ui";
import type { RoomParticipant } from "../lib/useCallRoom";

/** How big this tile is, which decides what it has room to say. */
type TileSize = "stage" | "grid" | "strip";

const NAME_TEXT: Record<TileSize, string> = {
  stage: "text-sm",
  grid: "text-xs",
  strip: "text-[10px]",
};

/**
 * The avatar follows the TILE, not the size class: a third of the tile's shorter
 * side, kept between a size a face-initial is legible at and one that stops
 * looking like an avatar. `cqmin` is relative to the tile (it is a size
 * container — see the root element below), so the same rule holds in a 1300px
 * stage, a 320px grid tile and a 128px filmstrip thumbnail.
 */
const AVATAR = "h-[clamp(2.25rem,32cqmin,8rem)] w-[clamp(2.25rem,32cqmin,8rem)] text-[clamp(0.875rem,11cqmin,2.5rem)]";

export function CallTile({
  p,
  size = "grid",
  pinned = false,
  active = false,
  handRaised = false,
  onTogglePin,
  source = "auto",
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
  /**
   * Which of `p`'s tracks this copy of them shows. "auto" (the default)
   * follows `p.sharing`, same as ever — the shape every OTHER caller wants.
   * "camera" forces the camera feed even while they are sharing: the
   * filmstrip's own copy of an on-stage sharer uses this, so their face stays
   * reachable alongside the big tile's screen instead of rendering the same
   * screen twice over.
   */
  source?: "auto" | "camera";
}) {
  const { t } = useTranslation("callRoom");
  const videoRef = useRef<HTMLVideoElement>(null);
  const camera = source === "camera";
  // A shared screen wins the tile: it is what the room is looking at, and it is
  // the one picture that is useless cropped, so it is letterboxed rather than
  // filled. Unless THIS copy was asked to show the camera regardless — see
  // the `source` prop above.
  const shown = camera ? p.videoTrack : p.sharing ? p.screenTrack : p.videoTrack;
  // Whether THIS tile is actually showing the screen — as opposed to `p.sharing`
  // on its own, which a "camera" copy overrides. Everything below that used to
  // read `p.sharing` directly reads this instead, so a "camera" copy of a
  // sharer never inherits the screen-only styling (the black letterbox, the
  // un-mirrored picture, the feedback-loop placeholder).
  const showingScreen = !camera && p.sharing;
  // Mirrors the condition the <video> element is rendered under, below.
  const showVideo = camera ? p.camOn : p.camOn || p.sharing;
  // The sharer's OWN capture, played back to themselves, is a video-feedback
  // loop rather than a picture: "Entire screen" (or a window/tab that includes
  // this app) captures the very tile that is showing the capture, so every
  // frame contains the previous one — a mirror that gets worse, not better,
  // once native Picture-in-Picture puts a second copy on top (see CallRoom's
  // pipTrack, which excludes this same case). A static reminder replaces the
  // live feed instead; everyone else still sees the real thing. Moot for a
  // "camera" copy — it was never going to show the screen at all.
  const selfSharePreview = p.isLocal && showingScreen;

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
        // [container-type:size] makes the tile a size container: its box is
        // decided ENTIRELY by whoever places it, and nothing inside it — a
        // camera's intrinsic size, or having no content at all — can grow or
        // collapse it. The pictures and the avatar are laid out against it
        // (absolute inset-0 / cq units) rather than against their own content.
        "group relative h-full min-h-0 w-full min-w-0 overflow-hidden rounded-xl bg-surface-2 ring-2 transition-colors [container-type:size]",
        p.speaking || active ? "ring-accent" : "ring-transparent",
        active && size === "stage" && "shadow-[0_0_28px_-6px_var(--color-accent)]",
        pinned && size !== "stage" && !active && "ring-accent/60",
      )}
    >
      {selfSharePreview ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black px-2 text-center text-white">
          <Monitor size={size === "strip" ? 18 : 28} className="text-red-400" />
          <span className={cn("font-medium", NAME_TEXT[size])}>{t("tile.presentingScreen")}</span>
        </div>
      ) : showVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          // Muting the local tile is not cosmetic: an unmuted local video
          // element is an echo loop.
          muted={p.isLocal}
          className={cn(
            // Out of flow (absolute inset-0) so the camera's intrinsic size
            // never takes part in layout: as an in-flow box a <video> whose
            // parent has no definite height falls back to its own aspect ratio,
            // and that height propagated up through the grid and made a
            // portrait or 4:3 camera's tile taller than the slot it was given.
            // The tile is the one sized thing; the picture fills it.
            //
            // object-contain, for camera and screen alike: the WHOLE frame is
            // always visible. object-cover crops to fill, which on a 4:3 or
            // portrait camera in a 16:9 tile discards a quarter to half of the
            // picture and enlarges the face by the same factor. The tile shapes
            // (lib/tileLayout) are chosen to match cameras, so a 16:9 camera has
            // no bars at all; the odd-shaped ones get bars, never a crop.
            "absolute inset-0 h-full w-full object-contain",
            showingScreen && "bg-black",
            // Only the local camera is mirrored, so the tile reads naturally to
            // the person looking at themselves — never a remote participant's
            // camera (they see the raw, un-mirrored track LiveKit publishes,
            // same as everyone else in the room), and never a screen share
            // (mirroring text on someone's screen would make it unreadable).
            p.isLocal && !showingScreen && "-scale-x-100",
          )}
        />
      ) : (
        // Camera off: the tile keeps its size (it never depended on the video)
        // and the avatar sits at its centre — both axes — whatever the shape.
        <div className="absolute inset-0 flex items-center justify-center">
          <div
            className={cn(
              "flex items-center justify-center rounded-full bg-accent-soft font-semibold text-accent",
              AVATAR,
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
          title={pinned ? t("tile.unpin", { name: p.name }) : t("tile.pin", { name: p.name })}
          aria-label={pinned ? t("tile.unpin", { name: p.name }) : t("tile.pin", { name: p.name })}
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
          title={t("tile.handRaisedTitle", { name: p.name })}
          className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-lg bg-amber-400 px-1.5 py-1 text-[10px] font-semibold text-amber-950"
        >
          <Hand size={12} />
        </span>
      )}

      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/60 to-transparent px-2 py-1.5">
        <span className={cn("truncate font-medium text-white", NAME_TEXT[size])}>
          {p.name}
          {p.isLocal && t("tile.youSuffix")}
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
  const { t } = useTranslation("callRoom");
  return (
    <button
      type="button"
      onClick={onClick}
      title={t("tile.unpinStageTitle", { name })}
      aria-label={t("tile.unpinStageAriaLabel")}
      className="absolute right-2 top-2 z-10 flex items-center gap-1.5 rounded-lg bg-black/55 px-2 py-1.5 text-[11px] font-medium text-white transition hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
    >
      <PinOff size={13} /> {t("tile.unpinStageButton")}
    </button>
  );
}
