/**
 * The member area: everyone in the room, in a space that never scrolls.
 *
 * ── Why pages instead of a scrolling grid ────────────────────────────────────
 * A call is not a list you read, it is a place you are IN. Scrolling to find
 * somebody means the person who was on screen a second ago is gone, and it
 * makes the size of the tiles a function of how many people turned up. So the
 * area is fixed: a full page of members, and the rest on the next page. Nothing
 * here moves under the cursor while the meeting is running.
 *
 * Twelve to a page — four across, three down at full width — which is where a
 * tile stops being big enough to read a face in.
 */
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@taskboard/ui";
import type { RoomParticipant } from "../lib/useCallRoom";
import { CallTile } from "./CallTile";

/** A full page of the member grid. */
export const MEMBERS_PER_PAGE = 12;

/** A page of the strip that runs above a pinned view. Fewer, because they share
 *  the height of one row and six is where a face stops being a face. */
export const STRIP_PER_PAGE = 6;

/** How many pages `total` members need. Always at least one, so an empty room
 *  still renders its (empty) page rather than a divide-by-zero. */
export function pageCount(total: number, perPage: number): number {
  return Math.max(1, Math.ceil(total / perPage));
}

export function CallMembers({
  participants,
  hands,
  pinned,
  onTogglePin,
  layout = "grid",
}: {
  participants: RoomParticipant[];
  /** Identities with a hand up. */
  hands: Set<string>;
  /** The pinned participant's identity, if any. */
  pinned: string | null;
  onTogglePin: (identity: string) => void;
  /** "grid" fills the room; "strip" is the row above a pinned view. */
  layout?: "grid" | "strip";
}) {
  const perPage = layout === "strip" ? STRIP_PER_PAGE : MEMBERS_PER_PAGE;
  const [page, setPage] = useState(0);
  const pages = pageCount(participants.length, perPage);

  // People leave, and the page they were on can stop existing. Clamping in an
  // effect rather than only at render keeps the pager's own state honest —
  // otherwise "next" from a clamped page jumps somewhere nobody asked for.
  useEffect(() => {
    setPage((p) => Math.min(p, pages - 1));
  }, [pages]);
  const current = Math.min(page, pages - 1);
  const shown = participants.slice(current * perPage, current * perPage + perPage);

  return (
    <div className={cn("flex min-h-0 flex-col gap-2", layout === "grid" && "flex-1")}>
      <div
        className={cn(
          // overflow-hidden, not auto: this area is the thing that must not
          // scroll. If tiles do not fit, that is what the pager is for.
          "grid min-h-0 gap-2 overflow-hidden",
          layout === "grid"
            ? "h-full flex-1 auto-rows-fr grid-cols-2 sm:grid-cols-3 xl:grid-cols-4"
            : "h-24 shrink-0 auto-cols-fr grid-flow-col sm:h-28",
        )}
      >
        {shown.map((p) => (
          <CallTile
            key={p.identity}
            p={p}
            size={layout === "strip" ? "strip" : "grid"}
            pinned={pinned === p.identity}
            handRaised={hands.has(p.identity)}
            onTogglePin={() => onTogglePin(p.identity)}
          />
        ))}
      </div>

      {pages > 1 && (
        <nav
          aria-label="Member pages"
          className="flex shrink-0 items-center justify-center gap-1.5 text-xs text-muted"
        >
          <button
            type="button"
            onClick={() => setPage(current - 1)}
            disabled={current === 0}
            title="Previous members"
            aria-label="Previous members"
            className="rounded-lg p-1 transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-40"
          >
            <ChevronLeft size={14} />
          </button>
          {Array.from({ length: pages }, (_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setPage(i)}
              aria-current={i === current ? "page" : undefined}
              aria-label={`Members page ${i + 1} of ${pages}`}
              className={cn(
                "min-w-6 rounded-md px-1.5 py-0.5 font-medium transition-colors",
                i === current ? "bg-accent text-accent-fg" : "bg-surface-2 hover:text-fg",
              )}
            >
              {i + 1}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setPage(current + 1)}
            disabled={current === pages - 1}
            title="More members"
            aria-label="More members"
            className="rounded-lg p-1 transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-40"
          >
            <ChevronRight size={14} />
          </button>
        </nav>
      )}
    </div>
  );
}
