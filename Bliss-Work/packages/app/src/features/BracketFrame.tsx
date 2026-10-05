/**
 * The sci-fi HUD frame around the main video area: four glowing corner
 * brackets rather than a solid border — the "targeting reticle" look the
 * redesign calls for. Applied identically to a speaker tile, a shared screen,
 * or the full participant grid, so whichever fills the main video area gets
 * the same frame.
 */
import type { ReactNode } from "react";
import { cn } from "@taskboard/ui";

const CORNER =
  "pointer-events-none absolute h-7 w-7 border-accent [filter:drop-shadow(0_0_6px_var(--color-accent))]";

export function BracketFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("relative min-h-0", className)}>
      <span className={cn(CORNER, "left-0 top-0 rounded-tl-lg border-l-2 border-t-2")} />
      <span className={cn(CORNER, "right-0 top-0 rounded-tr-lg border-r-2 border-t-2")} />
      <span className={cn(CORNER, "bottom-0 left-0 rounded-bl-lg border-b-2 border-l-2")} />
      <span className={cn(CORNER, "bottom-0 right-0 rounded-br-lg border-b-2 border-r-2")} />
      {/* An inset-0 box, not `h-full`: this frame gets its size from the flex
          row/column it sits in (it is `flex-1 min-h-0` at every call site), and
          a percentage height inside a flex item is only honoured when the
          browser can prove the item's height is definite — which it cannot in
          several of the shapes this frame is used in. Pinning the content to
          the frame's own box makes that question moot: whatever the frame is,
          the content is exactly that, and cannot push the frame taller. */}
      <div className="absolute inset-0 overflow-hidden rounded-2xl">{children}</div>
    </div>
  );
}
