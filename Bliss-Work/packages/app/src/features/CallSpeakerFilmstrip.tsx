/**
 * Everyone besides (or including) the stage, small, capped so it never grows
 * to compete with the stage for space. Whoever the stage is currently
 * following always has a seat in it — bumped to the front if their natural
 * position would otherwise fall past the cap — so "who's the active speaker"
 * reads the same way here as it does above, instead of sometimes being
 * off-screen in this row.
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
import { CallTile } from "./CallTile";
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
  /** Whoever is on the big stage right now — always kept visible and given
   *  the highlight, wherever they'd otherwise fall in the row. */
  activeId: string | null;
  hands: Set<string>;
  pinned: string | null;
  onTogglePin: (identity: string) => void;
  orientation?: "vertical" | "horizontal" | "auto";
  limit?: number;
}) {
  const { t } = useTranslation("calls");
  const active = participants.filter((p) => p.identity === activeId);
  const rest = participants.filter((p) => p.identity !== activeId);
  const shown = [...active, ...rest].slice(0, limit);
  const overflow = participants.length - shown.length;
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
        <div key={p.identity} className={cn("shrink-0", thumb)}>
          <CallTile
            p={p}
            size="strip"
            pinned={pinned === p.identity}
            active={p.identity === activeId}
            handRaised={hands.has(p.identity)}
            onTogglePin={() => onTogglePin(p.identity)}
          />
        </div>
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
