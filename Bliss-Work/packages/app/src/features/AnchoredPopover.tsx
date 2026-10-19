import { createPortal } from "react-dom";
import type { CSSProperties, HTMLAttributes, ReactNode, RefObject } from "react";
import { usePopoverPosition } from "../lib/usePopoverPosition";

type AnchoredPopoverProps = Omit<HTMLAttributes<HTMLDivElement>, "children" | "className" | "style"> & {
  anchor: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
  className?: string;
  align?: "start" | "end";
  preferred?: "above" | "below";
  gap?: number;
  maxPanelHeight?: CSSProperties["maxHeight"];
  boundary?: RefObject<HTMLElement | null>;
  layer?: "dropdown" | "popover";
  active?: boolean;
};

/**
 * Render an anchored panel outside local stacking and overflow contexts.
 * Placement stays tied to the trigger, flips when needed, and clamps to the
 * viewport (or a supplied scroll boundary).
 */
export function AnchoredPopover({
  anchor,
  panelRef,
  children,
  className,
  align = "end",
  preferred = "below",
  gap = 6,
  maxPanelHeight,
  boundary,
  layer = "dropdown",
  active = true,
  ...props
}: AnchoredPopoverProps) {
  const style = usePopoverPosition({
    anchor,
    panelRef,
    boundary,
    align,
    preferred,
    gap,
    active,
  });
  const panelStyle =
    maxPanelHeight && typeof style.maxHeight === "number"
      ? { ...style, maxHeight: `min(${style.maxHeight}px, ${maxPanelHeight})` }
      : style;
  const layerClass = layer === "popover" ? "z-[var(--z-popover)]" : "z-[var(--z-dropdown)]";

  if (!active || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={panelRef}
      className={`fixed ${layerClass} ${className ?? ""}`}
      style={panelStyle}
      {...props}
    >
      {children}
    </div>,
    document.body,
  );
}
