import { NavLink, type To } from "react-router-dom";
import { motion } from "framer-motion";
import type { ReactNode } from "react";

/**
 * The row shell every row in Mail's message column sits inside — MailRow's
 * feed rows and MailDraftList's draft rows both open this exact way: a
 * NavLink that fills with the active tint when its route is open and
 * otherwise draws a hairline under itself (the `after` rule, so it can
 * disappear under hover/selection without leaving a seam), wrapping a
 * motion.div that fades/slides the row in as it mounts. Pulled out once two
 * rows needed the identical wrapper so the active-state styling and mount
 * animation can't quietly drift apart between them.
 */
export function MailListRow({ to, children }: { to: To; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `group relative block rounded-xl px-3 py-3 transition-colors ${
          isActive
            ? "bg-accent-soft ring-1 ring-accent/20"
            : "after:absolute after:inset-x-3 after:bottom-0 after:h-px after:bg-border/45 after:transition-opacity hover:bg-surface-2/70 hover:after:opacity-0"
        }`
      }
    >
      <motion.div
        layout
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.14 }}
        className="flex items-start gap-3"
      >
        {children}
      </motion.div>
    </NavLink>
  );
}
