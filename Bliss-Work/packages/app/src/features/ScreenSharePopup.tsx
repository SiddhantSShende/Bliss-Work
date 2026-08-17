import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronsRight, ScreenShare, Square } from "lucide-react";
import { cn } from "@taskboard/ui";
import { useCallDuration } from "../lib/callTimer";

/**
 * "You are sharing your screen", and the way to stop.
 *
 * Shown to the SHARER ALONE. That is not a UI nicety — the API has no endpoint
 * that stops somebody else's share (POST /calls/{id}/share/stop takes no target
 * user), so this button is the only stop control that exists, and it belongs to
 * the one person whose screen is on the wire.
 *
 * It can be slid out of the way rather than dismissed. A share is easy to
 * forget you started, so the reminder does not go away — collapsed, it is a
 * small red tab on the edge of the call, one click from being a full panel
 * again. There is deliberately no close button.
 */
export function ScreenSharePopup({
  startedAt,
  onStop,
  className,
}: {
  /** When the call connected — the panel shows the call's own timer, the same
   *  one on the share control, not a second clock for the share. */
  startedAt?: number;
  onStop: () => void;
  className?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const duration = useCallDuration(startedAt);

  return (
    <div className={cn("absolute right-0 top-4 z-30 flex justify-end", className)}>
      <AnimatePresence initial={false} mode="wait">
        {collapsed ? (
          <motion.button
            key="tab"
            type="button"
            onClick={() => setCollapsed(false)}
            title="Show screen sharing controls"
            aria-label="Show screen sharing controls"
            aria-expanded={false}
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
            className="flex items-center gap-1.5 rounded-l-xl border border-r-0 border-red-500/40 bg-surface/95 py-2.5 pl-3 pr-2.5 shadow-card backdrop-blur"
          >
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-70" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
            </span>
            <ScreenShare size={16} className="text-red-500" />
          </motion.button>
        ) : (
          <motion.div
            key="panel"
            role="status"
            aria-live="polite"
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
            className="mr-4 flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-xl border border-red-500/40 bg-surface/95 py-2.5 pl-3.5 pr-2.5 shadow-card backdrop-blur"
          >
            <ScreenShare size={18} className="shrink-0 text-red-500" />
            <div className="min-w-0 leading-tight">
              <div className="truncate text-sm font-semibold text-fg">
                You're sharing your screen
              </div>
              <div className="text-xs tabular-nums text-muted">{duration}</div>
            </div>
            <button
              type="button"
              onClick={onStop}
              title="Stop sharing"
              aria-label="Stop sharing"
              className="flex shrink-0 items-center gap-1.5 rounded-lg bg-red-500 px-2.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-red-600"
            >
              <Square size={12} fill="currentColor" />
              Stop
            </button>
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              title="Slide out of the way"
              aria-label="Slide out of the way"
              aria-expanded
              className="shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <ChevronsRight size={16} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
