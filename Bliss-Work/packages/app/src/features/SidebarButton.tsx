/**
 * One vertical icon+label control — shared by every button in CallSidebar and
 * by CallMoreMenu's own trigger, so the whole left rail reads as one
 * consistent set of controls rather than several one-off buttons.
 */
import type { ReactNode } from "react";
import { cn } from "@taskboard/ui";

export function SidebarButton({
  icon,
  label,
  onClick,
  active = false,
  disabled = false,
  title,
  badge = 0,
  /** Overrides the default cyan glow — used for the warning-coloured Raise
   *  Hand and the danger-coloured Record active states. */
  activeClassName = "bg-accent-soft text-accent ring-1 ring-accent [filter:drop-shadow(0_0_6px_var(--color-accent))]",
  className,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  badge?: number;
  activeClassName?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      aria-label={title ?? label}
      aria-pressed={active}
      className={cn(
        "flex w-16 shrink-0 flex-col items-center gap-1 rounded-xl px-1 py-2.5 text-muted transition-colors",
        "hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40",
        active && activeClassName,
        className,
      )}
    >
      <span className="relative inline-flex">
        {icon}
        {/* The count, not just a dot: "someone said something" and "eleven
            messages went by" are different situations to come back to. */}
        {badge > 0 && (
          <span
            aria-hidden
            className="absolute -right-2 -top-1.5 min-w-[15px] rounded-full bg-danger px-1 text-[9px] font-bold leading-[15px] text-white"
          >
            {badge > 9 ? "9+" : badge}
          </span>
        )}
      </span>
      <span className="text-[10px] font-medium leading-none">{label}</span>
    </button>
  );
}
