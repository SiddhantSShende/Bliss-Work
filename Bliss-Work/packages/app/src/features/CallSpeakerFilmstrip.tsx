/**
 * Everyone besides (or including) the stage, small, capped so it never grows
 * to compete with the stage for space. Whoever the stage is currently
 * following always has a seat in it — bumped to the front if their natural
 * position would otherwise fall past the cap — so "who's the active speaker"
 * reads the same way here as it does above, instead of sometimes being
 * off-screen in this row.
 *
 * Two orientations, chosen by the caller to match which of the redesign's two
 * main-content layouts is showing: a VERTICAL stack beside a speaking
 * participant's stage tile, a HORIZONTAL row below a shared screen (a wide
 * screen capture and a side column fight each other for width; a row below
 * it doesn't).
 */
import { Users } from "lucide-react";
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
  orientation?: "vertical" | "horizontal";
  limit?: number;
}) {
  const active = participants.filter((p) => p.identity === activeId);
  const rest = participants.filter((p) => p.identity !== activeId);
  const shown = [...active, ...rest].slice(0, limit);
  const overflow = participants.length - shown.length;
  const vertical = orientation === "vertical";

  return (
    <div
      className={cn(
        "flex shrink-0 gap-2",
        vertical ? "h-full w-32 flex-col overflow-y-auto" : "h-24 overflow-x-auto",
      )}
      aria-label="Other participants"
    >
      {shown.map((p) => (
        <div key={p.identity} className={cn("shrink-0", vertical ? "aspect-video w-full" : "h-full w-28")}>
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
            vertical ? "aspect-video w-full" : "h-full w-28",
          )}
        >
          <Users size={16} />
          <span className="text-[11px] font-medium leading-tight">+{overflow} More members</span>
        </div>
      )}
    </div>
  );
}
