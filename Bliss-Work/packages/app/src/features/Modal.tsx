import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useTranslation } from "react-i18next";
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
 *
 * FOOTER: a dialog whose actions must stay reachable passes `footer`. It is a
 * `shrink-0` sibling BELOW the scrolling body — never a `position:sticky`
 * child inside it. A sticky footer is pinned to the scroller's content box
 * (24px above the dialog edge, because of the body padding), so scrolled
 * content showed through the gap beneath it, and the browser's
 * focus-into-view scrolled controls behind it because it doesn't know an
 * overlay is there. A sibling shrinks the scrollport instead, so neither can
 * happen.
 */

/** Escape-to-close + focus trap + focus restore, shared by Modal and Sheet —
 *  and exported for a dialog that needs this exact behavior but not Modal's
 *  own themed chrome (e.g. NewMeetingDialog, which is deliberately NOT
 *  theme-surface-colored — see its own doc comment). */
export function useDialogBehavior(open: boolean, onClose: () => void) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  // Read via a ref inside the effect rather than closing over `onClose`
  // directly. Several callers pass a fresh inline closure on every render
  // (e.g. `onClose={busy ? () => {} : onClose}`), and `onClose` used to be a
  // dependency of the effect below — so typing into a second field re-ran the
  // whole "move focus into the dialog" setup on every keystroke, yanking
  // focus back to the first focusable element and making the field
  // untypeable past its first character.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

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
    // A header close button (data-dialog-close) is first in DOM order but is
    // never where typing should start, so the first real control wins.
    const initial = focusables();
    (initial.find((el) => !el.hasAttribute("data-dialog-close")) ?? initial[0] ?? panelRef.current)?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
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
    // Deliberately NOT depending on `onClose` — see onCloseRef above.
  }, [open]);

  return panelRef;
}

/** Lightweight centered modal. */
export function Modal({
  open,
  onClose,
  children,
  title,
  footer,
  wide = false,
  showClose = false,
  elevated = false,
  headerExtra,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
  /** Pinned under the scrolling body (see FOOTER above). Optional: every
   *  existing caller renders its own buttons inside `children`, unchanged. */
  footer?: React.ReactNode;
  /** Desktop-form width (~896px) instead of the default narrow dialog. */
  wide?: boolean;
  /** An X beside the title (opt-in, like Sheet's). Needs `title`. */
  showClose?: boolean;
  /** Opt-in: rendered in the title row, between the title and the close X
   *  (e.g. CreateTaskDialog's "+ New" project action). Every existing caller
   *  omits it and the header is unchanged. */
  headerExtra?: React.ReactNode;
  /**
   * Opt-in: render in its own layer and with a lighter scrim. Off for every
   * existing dialog, which are unchanged.
   *
   * The ordinary overlay stays in its caller's tree and uses the shared modal
   * layer. This opt-in portal is for dialogs that must escape a pane's overflow
   * or stacking context (for example, Add Channel).
   *
   * This portals to <body> (so no ancestor can cap or reorder it) at the modal
   * layer — above dropdowns and notes, below notifications — so the scrim covers
   * everything behind the dialog, notes included, and it is always centred in
   * the viewport. The scrim is `black/30` with a 2px blur: enough to establish
   * focus without turning the app behind into a smear.
   */
  elevated?: boolean;
}) {
  const { t } = useTranslation("common");
  const panelRef = useDialogBehavior(open, onClose);

  const overlay = (
    <AnimatePresence>
      {open && (
        <motion.div
          className={`fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4 ${
            elevated ? "bg-black/30 backdrop-blur-[2px]" : "bg-black/40 backdrop-blur-sm"
          }`}
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
            className={`flex max-h-[calc(100dvh-2rem)] w-full ${wide ? "max-w-4xl" : "max-w-md"} flex-col rounded-2xl border border-border bg-surface shadow-card`}
            initial={{ scale: 0.96, y: 10 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, y: 10 }}
            transition={{ type: "spring", stiffness: 360, damping: 30 }}
            onClick={(e) => e.stopPropagation()}
          >
            {title && (
              <div className={`flex shrink-0 items-start justify-between gap-3 px-6 ${wide ? "pt-5" : "pt-6"}`}>
                <h2 className="min-w-0 flex-1 text-lg font-semibold tracking-tight text-fg">{title}</h2>
                {headerExtra}
                {showClose && (
                  <button
                    type="button"
                    onClick={onClose}
                    data-dialog-close
                    title={t("modal.close")}
                    aria-label={t("modal.close")}
                    className="-mr-1 shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
                  >
                    <X size={15} />
                  </button>
                )}
              </div>
            )}
            <div
              className={`min-h-0 flex-1 overflow-y-auto px-6 ${wide ? "pb-4" : "pb-6"} ${title ? (wide ? "pt-3" : "pt-4") : "pt-6"}`}
            >
              {children}
            </div>
            {footer && (
              // rounded-b-2xl: the panel isn't overflow-hidden, so a square
              // opaque footer would paint over the panel's rounded corners.
              <div className="shrink-0 rounded-b-2xl border-t border-border bg-surface px-6 py-3">{footer}</div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
  return elevated && typeof document !== "undefined" ? createPortal(overlay, document.body) : overlay;
}

/** Slide-over sheet, from the right by default. */
export function Sheet({
  open,
  onClose,
  children,
  title,
  showClose = false,
  side = "right",
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
  /** Which edge the panel slides in from. Defaults to "right" (every existing
   *  caller) — "left" is for the mobile nav drawer, which needs the
   *  hamburger-opens-a-left-drawer convention every other sheet doesn't. */
  side?: "left" | "right";
}) {
  const { t } = useTranslation("common");
  const panelRef = useDialogBehavior(open, onClose);
  const fromLeft = side === "left";

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className={`fixed inset-x-0 bottom-0 top-[var(--titlebar-inset,0px)] z-[var(--z-modal)] flex ${fromLeft ? "justify-start" : "justify-end"} bg-black/30 backdrop-blur-sm`}
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
            className={`flex h-full w-full max-w-sm flex-col bg-surface shadow-card ${
              fromLeft ? "border-r border-border" : "border-l border-border"
            }`}
            initial={{ x: fromLeft ? -48 : 48 }}
            animate={{ x: 0 }}
            exit={{ x: fromLeft ? -48 : 48 }}
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
                    title={t("modal.close")}
                    aria-label={t("modal.close")}
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
