import { useEffect, type CSSProperties, type PointerEvent } from "react";

/**
 * Eight edge/corner resize zones for the pinned note on Linux, where the OS
 * cannot resize it (see main/sticky-resize.ts). Main resizes the real window
 * from the cursor while one is held; this only reports press and release.
 *
 * `app-no-drag` is required: the note's card is an OS drag region, which would
 * otherwise claim a press on these zones as a window move. Cursors match the
 * native resize cursors the window used to show.
 */
const EDGE = 6;
const CORNER = 12;

interface Zone {
  edge: string;
  cursor: string;
  style: CSSProperties;
}

const ZONES: Zone[] = [
  { edge: "n", cursor: "ns-resize", style: { top: 0, left: CORNER, right: CORNER, height: EDGE } },
  { edge: "s", cursor: "ns-resize", style: { bottom: 0, left: CORNER, right: CORNER, height: EDGE } },
  { edge: "w", cursor: "ew-resize", style: { left: 0, top: CORNER, bottom: CORNER, width: EDGE } },
  { edge: "e", cursor: "ew-resize", style: { right: 0, top: CORNER, bottom: CORNER, width: EDGE } },
  { edge: "nw", cursor: "nwse-resize", style: { top: 0, left: 0, width: CORNER, height: CORNER } },
  { edge: "se", cursor: "nwse-resize", style: { bottom: 0, right: 0, width: CORNER, height: CORNER } },
  { edge: "ne", cursor: "nesw-resize", style: { top: 0, right: 0, width: CORNER, height: CORNER } },
  { edge: "sw", cursor: "nesw-resize", style: { bottom: 0, left: 0, width: CORNER, height: CORNER } },
];

export function StickyResizeHandles() {
  return (
    <>
      {ZONES.map(({ edge, cursor, style }) => (
        <div
          key={edge}
          data-resize-edge={edge}
          className="app-no-drag"
          style={{ position: "fixed", zIndex: 50, touchAction: "none", cursor, ...style }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            // Capture so the release is seen even once the cursor leaves the window.
            e.currentTarget.setPointerCapture(e.pointerId);
            window.sticky.dragStart(edge);
          }}
          onPointerUp={() => window.sticky.dragEnd()}
          onLostPointerCapture={() => window.sticky.dragEnd()}
        />
      ))}
    </>
  );
}

/** Anything a press on should act on itself rather than start moving the note. */
const INTERACTIVE = ".app-no-drag, button, a, input, textarea, select";

/**
 * Linux only: move the note by its body. The card and pill are
 * `-webkit-app-region: drag`, which Chromium turns into a window-manager move
 * request the note's window never answers (see main/sticky-resize.ts). So on
 * Linux that region is switched off (index.css) and a press on the non-
 * interactive body asks main to follow the cursor instead. Elsewhere this is a
 * no-op and the OS drag region does the job.
 */
export function useManualMove() {
  const manual = window.sticky.manualResize;
  useEffect(() => {
    if (!manual) return;
    document.documentElement.setAttribute("data-manual-drag", "");
    return () => document.documentElement.removeAttribute("data-manual-drag");
  }, [manual]);
  if (!manual) return {};
  return {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || (e.target as Element).closest(INTERACTIVE)) return;
      e.preventDefault(); // no text selection while dragging
      // Capture so the release is seen even once the cursor leaves the window.
      e.currentTarget.setPointerCapture(e.pointerId);
      window.sticky.dragStart("move");
    },
    onPointerUp: () => window.sticky.dragEnd(),
    onLostPointerCapture: () => window.sticky.dragEnd(),
  };
}
