import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";

/**
 * Shared dialog primitives.
 *
 * SCROLLING: both of these cap their height and scroll their BODY, with the
 * title pinned. Neither used to, and because the backdrop is `fixed inset-0`
 * (and the app shell itself is `position:fixed; overflow:hidden`) the page
 * behind can't scroll either — so on a short viewport a tall dialog simply ran
 * off the bottom of the screen with its submit button unreachable. Every dialog
 * in the app inherits from here, so this is fixed once rather than per-dialog.
 *
 * `dvh` rather than `vh`: on mobile browsers the URL bar makes `vh` overshoot
 * the visible area, which is exactly the case we're trying to fix.
 */

/** Escape-to-close + focus trap + focus restore, shared by Modal and Sheet. */
function useDialogBehavior(open: boolean, onClose: () => void) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement as HTMLElement | null;

    // Move focus into the dialog so a keyboard user isn't left behind it.
    //
    // Visibility is decided by computed style rather than `offsetParent !== null`.
    // offsetParent is null for ANY position:fixed element, so that idiom would
    // silently drop a fixed-position control out of the focus trap — and it is
    // unimplemented in jsdom, which made this whole path untestable.
    const isVisible = (el: HTMLElement) => {
      if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden";
    };

    const focusables = () =>
      Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter(isVisible);
    (focusables()[0] ?? panelRef.current)?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      // Trap: Tab past either end wraps instead of escaping to the page behind.
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panelRef.current?.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      restoreTo.current?.focus?.();
    };
  }, [open, onClose]);

  return panelRef;
}

/** Lightweight centered modal. */
export function Modal({
  open,
  onClose,
  children,
  title,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  const panelRef = useDialogBehavior(open, onClose);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            tabIndex={-1}
            // max-h + flex column: the header stays put and the body scrolls,
            // so the footer's buttons are always reachable.
            className="flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col rounded-2xl border border-border bg-surface shadow-card"
            initial={{ scale: 0.96, y: 10 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, y: 10 }}
            transition={{ type: "spring", stiffness: 360, damping: 30 }}
            onClick={(e) => e.stopPropagation()}
          >
            {title && (
              <h2 className="shrink-0 px-6 pt-6 text-lg font-semibold tracking-tight text-fg">
                {title}
              </h2>
            )}
            <div className={`min-h-0 flex-1 overflow-y-auto px-6 pb-6 ${title ? "pt-4" : "pt-6"}`}>
              {children}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Right-side slide-over sheet. */
export function Sheet({
  open,
  onClose,
  children,
  title,
  showClose = false,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
  /**
   * Render an X in the header alongside the title.
   *
   * Opt-in rather than always-on: the sheets that predate it close on the
   * backdrop, on Escape and on their own footer buttons, and giving every one
   * of them a second dismiss control is a change to those screens, not to this
   * primitive. Needs `title` — the X lives in the title row.
   */
  showClose?: boolean;
}) {
  const panelRef = useDialogBehavior(open, onClose);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex justify-end bg-black/30 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            tabIndex={-1}
            className="flex h-full w-full max-w-sm flex-col border-l border-border bg-surface shadow-card"
            initial={{ x: 48 }}
            animate={{ x: 0 }}
            exit={{ x: 48 }}
            transition={{ type: "spring", stiffness: 340, damping: 34 }}
            onClick={(e) => e.stopPropagation()}
          >
            {title && (
              <div className="flex shrink-0 items-start justify-between gap-3 px-5 pt-5">
                <h2 className="min-w-0 text-lg font-semibold tracking-tight text-fg">{title}</h2>
                {showClose && (
                  <button
                    type="button"
                    onClick={onClose}
                    title="Close"
                    aria-label="Close"
                    className="-mr-1 shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
                  >
                    <X size={15} />
                  </button>
                )}
              </div>
            )}
            <div className={`min-h-0 flex-1 overflow-y-auto px-5 pb-5 ${title ? "pt-4" : "pt-5"}`}>
              {children}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
