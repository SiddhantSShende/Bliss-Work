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
 * Twelve to a page at most — four across, three down at full width — which is
 * where a tile stops being big enough to read a face in. A smaller area (a
 * phone, or the chat panel open) holds fewer per page for the same reason: see
 * membersPerPage.
 *
 * ── How the tiles get their size ─────────────────────────────────────────────
 * Not from CSS. The area is measured, lib/tileLayout works out the column count
 * and tile size that use it best, and every tile is handed those exact pixels.
 * A tile therefore ALWAYS has a definite size — nothing about its content (a
 * camera's intrinsic aspect ratio, or the lack of any content when the camera is
 * off) can grow or collapse it — and the arrangement follows the shape of the
 * area rather than the viewport.
 */
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@taskboard/ui";
import type { RoomParticipant } from "../lib/useCallRoom";
import { fitTiles, membersPerPage } from "../lib/tileLayout";
import { useElementSize } from "../lib/useElementSize";
import { CallTile } from "./CallTile";

/** A full page of the member grid. */
const MEMBERS_PER_PAGE = 12;

/** A page of the grid beside a pinned stage. Fewer, and always two across —
 *  the column's own width doesn't have room to spare for a third. */
const SIDEBAR_PER_PAGE = 6;

/** The space between tiles, in px. A number rather than a Tailwind class because
 *  lib/tileLayout does arithmetic with it. */
const GAP = 8;

/** Splits `items` into consecutive rows of `size`. */
function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

/** How many pages `total` members need. Always at least one, so an empty room
 *  still renders its (empty) page rather than a divide-by-zero. */
function pageCount(total: number, perPage: number): number {
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
  /** "grid" fills the room; "sidebar" is the column beside a pinned stage. */
  layout?: "grid" | "sidebar";
}) {
  const { t } = useTranslation("calls");
  const maxPerPage = layout === "sidebar" ? SIDEBAR_PER_PAGE : MEMBERS_PER_PAGE;
  // The area the tiles share. Null for the one frame before it is measured, in
  // which case nothing is drawn (see useElementSize) and the page size is the
  // full one.
  const [areaRef, area] = useElementSize<HTMLDivElement>();
  const perPage = area ? membersPerPage(area, GAP, maxPerPage) : maxPerPage;
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

  // Alone in the room, a tile sized for a multi-person grid reads as small and
  // stranded in the corner. One participant gets the room's full attention
  // instead, at the same large sizing a pinned/stage tile already uses
  // elsewhere — see the `size` prop below.
  const solo = shown.length === 1;
  const fit = area && !solo ? fitTiles(shown.length, area, GAP) : null;
  // Tiles this narrow have no room for the ordinary avatar and name.
  const tileSize = fit && fit.width < 140 ? "strip" : "grid";

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col gap-2",
        // h-full as well as flex-1: this sits in BracketFrame's inset-0 box,
        // which is a plain block, where flex-1 alone does nothing.
        layout === "grid" ? "h-full flex-1" : "h-28 w-full shrink-0 sm:h-auto sm:w-64",
      )}
    >
      {/* The measured area. It takes its size from the flex column it sits in
          and NEVER from the tiles inside it — those are absolutely positioned —
          so measuring it cannot feed back into itself. overflow-hidden, not
          auto: this area is the thing that must not scroll. If tiles do not
          fit, that is what the pager is for. */}
      <div ref={areaRef} className="relative min-h-0 flex-1 overflow-hidden">
        {solo ? (
          <div className="absolute inset-0">
            <CallTile
              p={shown[0]!}
              size="stage"
              pinned={pinned === shown[0]!.identity}
              handRaised={hands.has(shown[0]!.identity)}
              onTogglePin={() => onTogglePin(shown[0]!.identity)}
            />
          </div>
        ) : (
          fit && (
            // Row by row, each centred, so a last row with fewer tiles sits in
            // the middle rather than hugging the left edge.
            <div
              className="absolute inset-0 flex flex-col items-center justify-center"
              style={{ gap: GAP }}
            >
              {chunk(shown, fit.cols).map((row) => (
                <div key={row[0]!.identity} className="flex justify-center" style={{ gap: GAP }}>
                  {row.map((p) => (
                    <div key={p.identity} className="shrink-0" style={{ width: fit.width, height: fit.height }}>
                      <CallTile
                        p={p}
                        size={tileSize}
                        pinned={pinned === p.identity}
                        handRaised={hands.has(p.identity)}
                        onTogglePin={() => onTogglePin(p.identity)}
                      />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )
        )}
      </div>

      {pages > 1 && (
        <nav
          aria-label={t("members.pagesAriaLabel")}
          className="flex shrink-0 items-center justify-center gap-1.5 text-xs text-muted"
        >
          <button
            type="button"
            onClick={() => setPage(current - 1)}
            disabled={current === 0}
            title={t("members.previous")}
            aria-label={t("members.previous")}
            className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-40"
          >
            <ChevronLeft size={14} />
          </button>
          {Array.from({ length: pages }, (_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setPage(i)}
              aria-current={i === current ? "page" : undefined}
              aria-label={t("members.pageAriaLabel", { page: i + 1, pages })}
              className={cn(
                "h-7 min-w-7 rounded-md px-1.5 font-medium transition-colors",
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
            title={t("members.more")}
            aria-label={t("members.more")}
            className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-40"
          >
            <ChevronRight size={14} />
          </button>
        </nav>
      )}
    </div>
  );
}
