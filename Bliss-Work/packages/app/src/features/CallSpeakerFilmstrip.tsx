/**
 * Everyone besides the stage, small, capped so it never grows to compete with
 * the stage for space. The stage participant is deliberately left OUT —
 * their tile is already the big one — with one exception: while they are
 * SHARING, the big tile is showing their screen, not their face, so they get
 * a seat here too (first, so a full row can never push it out), showing their
 * camera instead (see CallTile's `source` prop). Leaving them in
 * unconditionally, the way this component used to, spent one of the strip's
 * limited seats on a second copy of the exact picture already on the stage —
 * with four participants and a cap of three, that meant only two of the other
 * three were ever reachable.
 *
 * Three orientations, chosen by the caller to match which of the redesign's
 * main-content layouts is showing: a VERTICAL stack beside a speaking
 * participant's stage tile, a HORIZONTAL row below a shared screen (a wide
 * screen capture and a side column fight each other for width; a row below
 * it doesn't), or AUTO for the speaker layout, which is the vertical stack when
 * the area is wide enough to spare a column and the horizontal row when it is
 * not (a narrow window, or the chat panel open). "Wide enough" is asked of the
 * nearest `@container` ancestor, not of the viewport, because the room the
 * stage really has is what is left after the side panel took its share.
 */
import { Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@taskboard/ui";
import { CallTileSlot } from "./CallTileHost";
import type { RoomParticipant } from "../lib/useCallRoom";

export function CallSpeakerFilmstrip({
  participants,
  activeId,
  hands,
  pinned,
  onTogglePin,
  orientation = "horizontal",
  /** Real thumbnails shown before the row/stack folds the rest into a "+N"
   *  card. Three beside a stage tile reads as a companion strip; four below a
   *  screen share still leaves the share itself the dominant shape. */
  limit = orientation === "vertical" ? 3 : 5,
}: {
  participants: RoomParticipant[];
  /** Whoever is on the big stage right now — left out of this row entirely,
   *  except as the camera-only entry described in the module doc above. */
  activeId: string | null;
  hands: Set<string>;
  pinned: string | null;
  onTogglePin: (identity: string) => void;
  orientation?: "vertical" | "horizontal" | "auto";
  limit?: number;
}) {
  const { t } = useTranslation("calls");
  const stage = participants.find((p) => p.identity === activeId);
  const rest = participants.filter((p) => p.identity !== activeId);
  // See the module doc above: the stage rejoins the pool, camera-only, only
  // while it is a screen share — anyone just speaking or pinned already has
  // their one and only tile up on the big stage.
  const pool = stage?.sharing ? [stage, ...rest] : rest;
  const shown = pool.slice(0, limit);
  const overflow = pool.length - shown.length;
  const vertical = orientation === "vertical";
  const auto = orientation === "auto";

  // A thumbnail's box, per orientation. 16:9 in every one — the shape a camera
  // is — so the picture fills it: a row of them is as tall as the row, a stack
  // of them as wide as the stack.
  const thumb = auto
    ? "aspect-video h-full @xl:h-auto @xl:w-full"
    : vertical
      ? "aspect-video w-full"
      : "aspect-video h-full";

  return (
    <div
      className={cn(
        "flex shrink-0 gap-2",
        auto
          ? "h-24 overflow-x-auto @xl:h-full @xl:w-32 @xl:flex-col @xl:overflow-y-auto @xl:overflow-x-hidden"
          : vertical
            ? "h-full w-32 flex-col overflow-y-auto"
            : "h-24 overflow-x-auto",
      )}
      aria-label={t("filmstrip.ariaLabel")}
    >
      {shown.map((p) => (
        <CallTileSlot
          key={p.identity}
          className={cn("shrink-0", thumb)}
          p={p}
          size="strip"
          pinned={pinned === p.identity}
          active={p.identity === activeId}
          // Only the stage's own re-included entry (see `pool` above) is
          // ever the sharer — everyone else here already shows auto's
          // ordinary camera-or-screen picture.
          source={p.identity === activeId ? "camera" : "auto"}
          handRaised={hands.has(p.identity)}
          onTogglePin={() => onTogglePin(p.identity)}
        />
      ))}
      {overflow > 0 && (
        <div
          className={cn(
            "flex shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-border/70 bg-surface-2 text-center text-muted",
            thumb,
          )}
        >
          <Users size={16} />
          <span className="text-[11px] font-medium leading-tight">
            {t("filmstrip.moreMembers", { count: overflow })}
          </span>
        </div>
      )}
    </div>
  );
}
