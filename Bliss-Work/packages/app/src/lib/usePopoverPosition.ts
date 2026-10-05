import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

/** Breathing room between the anchor and the panel, and the panel and
 *  whatever edge it is bounded by. One constant, so placements never
 *  disagree with each other. */
export const POPOVER_GAP = 8;

/**
 * Flip-aware placement for a panel that is portalled to document.body,
 * measured against `boundary` (defaults to the viewport).
 *
 * ── Why a boundary, not just the viewport ───────────────────────────────────
 * A panel anchored inside a scroll container has to be portalled to escape
 * that container's clipping (see EmojiPopup), which means it is placed in
 * `fixed` coordinates. Placing it against the viewport is fine when the
 * anchor's own scroll box fills the viewport, but a chat thread sits below a
 * fixed top bar: a panel that only checks viewport space can flip "above"
 * and land underneath that bar. Passing the scroll container as `boundary`
 * measures space against the container's own edges instead, so the panel
 * never reasons about room the container does not actually have.
 *
 * ── Measured, not guessed ───────────────────────────────────────────────────
 * The panel is mounted hidden, measured for its real height/width, and only
 * then placed — a hardcoded height guess drifts out of sync with whatever
 * the panel actually renders as.
 *
 * `maxHeight` is set to whichever space the panel ends up using, so a panel
 * that still does not fully fit scrolls internally instead of overflowing
 * past the boundary.
 */
export function usePopoverPosition({
  anchor,
  panelRef,
  boundary,
  preferred = "below",
  align = "start",
  gap = POPOVER_GAP,
  active = true,
}: {
  anchor: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  /** Bounds placement is measured against. Defaults to the viewport. */
  boundary?: RefObject<HTMLElement | null>;
  /** Which side is tried first; falls back to whichever side has more room. */
  preferred?: "above" | "below";
  /** Horizontal alignment to the anchor: its left edge, or its right edge. */
  align?: "start" | "end";
  gap?: number;
  /**
   * Whether the panel is currently open. Only needed when the panel is
   * conditionally rendered by a component that itself stays mounted (its own
   * refs and callbacks stay referentially stable, so nothing else in the
   * dependency list changes) — without this, the effect that measures and
   * places the panel would never re-run when it opens. A panel whose own
   * component mounts and unmounts with it (like EmojiPopup) does not need
   * this; the effect already reruns on every fresh mount.
   */
  active?: boolean;
}): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({
    // Hidden rather than unmounted for the first pass: the panel has to be in
    // the document to have a size to measure, and `visibility` reserves
    // layout without painting it.
    visibility: "hidden",
    top: 0,
    left: 0,
  });

  useLayoutEffect(() => {
    if (!active) return;
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const el = panelRef.current;
      if (!a || !el) return;

      const b = boundary?.current?.getBoundingClientRect();
      const boundTop = b?.top ?? 0;
      const boundBottom = b?.bottom ?? window.innerHeight;
      const boundLeft = b?.left ?? 0;
      const boundRight = b?.right ?? window.innerWidth;

      const height = el.offsetHeight;
      const width = el.offsetWidth;
      const spaceAbove = a.top - boundTop - gap;
      const spaceBelow = boundBottom - a.bottom - gap;

      // Try the preferred side first; fall back to it whenever it has at
      // least as much room as the other side, even if neither fully fits —
      // that side still gets the `maxHeight` treatment below.
      const preferredSpace = preferred === "below" ? spaceBelow : spaceAbove;
      const otherSpace = preferred === "below" ? spaceAbove : spaceBelow;
      const usesPreferred = preferredSpace >= height || preferredSpace >= otherSpace;
      const below = preferred === "below" ? usesPreferred : !usesPreferred;

      const anchorLeft = align === "end" ? a.right - width : a.left;

      setStyle({
        visibility: "visible",
        top: below ? a.bottom + gap : Math.max(boundTop + gap, a.top - height - gap),
        // Clamped to the boundary on both sides, so a trigger near its edge
        // does not push the panel past it.
        left: Math.max(boundLeft + gap, Math.min(anchorLeft, boundRight - width - gap)),
        maxHeight: Math.max(0, below ? spaceBelow : spaceAbove),
      });
    };

    place();
    window.addEventListener("resize", place);
    // Capture, so a nested scroll container moving the anchor repositions the
    // panel too — a scroll event from a nested container does not bubble.
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, panelRef, boundary, preferred, align, gap, active]);

  return style;
}
