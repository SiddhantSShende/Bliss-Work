/**
 * The row under the stage: everyone, small, capped at five tiles so it never
 * grows to compete with the stage for height. Whoever the stage is currently
 * following always has a seat in it — bumped to the front if their natural
 * position would otherwise fall past the cap — so "who's the active speaker"
 * reads the same way here as it does above, instead of sometimes being
 * off-screen in this row.
 */
import { Users } from "lucide-react";
import { CallTile } from "./CallTile";
import type { RoomParticipant } from "../lib/useCallRoom";

/** Real thumbnails shown before the row folds the rest into a "+N" card. */
const VISIBLE_LIMIT = 5;

export function CallSpeakerFilmstrip({
  participants,
  activeId,
  hands,
  pinned,
  onTogglePin,
}: {
  participants: RoomParticipant[];
  /** Whoever is on the big stage right now — always kept visible and given
   *  the highlight, wherever they'd otherwise fall in the row. */
  activeId: string | null;
  hands: Set<string>;
  pinned: string | null;
  onTogglePin: (identity: string) => void;
}) {
  const active = participants.filter((p) => p.identity === activeId);
  const rest = participants.filter((p) => p.identity !== activeId);
  const shown = [...active, ...rest].slice(0, VISIBLE_LIMIT);
  const overflow = participants.length - shown.length;

  return (
    <div className="flex h-20 shrink-0 gap-2 overflow-x-auto sm:h-24" aria-label="Other participants">
      {shown.map((p) => (
        <div key={p.identity} className="h-full w-28 shrink-0">
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
        <div className="flex h-full w-28 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-border/70 bg-surface-2 text-center text-muted">
          <Users size={16} />
          <span className="text-[11px] font-medium leading-tight">+{overflow} More members</span>
        </div>
      )}
    </div>
  );
}
