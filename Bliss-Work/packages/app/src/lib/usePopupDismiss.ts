/**
 * One popup's dismissal behaviour: outside click, Escape, and the rule that
 * opening one closes the others.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The chat and channel surfaces had grown two rival ways of closing a popup,
 * and neither knew about the other:
 *
 *   • a click-away backdrop — a `fixed inset-0` div under the panel, closing on
 *     its own click (CallMenu, ConversationMenu, ChatsList)
 *   • a document `mousedown` listener, closing when the target is outside the
 *     wrapper (EmojiPicker, MessageActions)
 *
 * Two consequences, both of which read as bugs. A backdrop dismisses only the
 * menu that owns it, so a header menu stayed open when an emoji picker opened
 * on top of it and the screen ended up with two panels on it. And a backdrop
 * that covers the viewport EATS the click that was meant for another control,
 * so switching between two menus took two clicks — the first one going nowhere.
 * Neither backdrop-based menu handled Escape at all.
 *
 * ── The contract ────────────────────────────────────────────────────────────
 * Attach the returned ref to a wrapper that contains BOTH the trigger and the
 * panel. That is what makes clicking the trigger to close work: the trigger
 * counts as inside, so this hook does not close the popup a moment before the
 * button's own onClick toggles it — which would reopen it and leave a control
 * that visibly does nothing.
 *
 * Panels rendered through a portal (EmojiPopup puts its grid on document.body,
 * so a bubble near the window edge is not clipped by the thread's scroll box)
 * are not inside that wrapper in the DOM. Pass their refs as `alsoInside`.
 */
import { useEffect, useRef, type RefObject } from "react";

/**
 * Every popup open right now, keyed by the callback that closes it.
 *
 * Module-level on purpose: "only one popup at a time" is a statement about the
 * whole screen, and there is no common ancestor for a composer emoji picker, a
 * message's action menu and a header dropdown that does not amount to putting
 * this in a context provider around the entire app for a Set of two entries.
 */
const openPopups = new Set<() => void>();

export function usePopupDismiss<T extends HTMLElement = HTMLDivElement>(
  open: boolean,
  onClose: () => void,
  /** Refs to panels rendered outside the wrapper — portals. */
  alsoInside: ReadonlyArray<RefObject<HTMLElement | null>> = [],
): RefObject<T | null> {
  const wrapRef = useRef<T>(null);

  // Both read by listeners that are registered once per open. Without the
  // indirection the effect would have to depend on `onClose` and on the
  // `alsoInside` array, and a caller passing either inline — which every caller
  // does — would tear the listeners down and rebuild them on every render.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const insideRef = useRef(alsoInside);
  insideRef.current = alsoInside;

  useEffect(() => {
    if (!open) return;

    const close = () => closeRef.current();

    // Close whatever was already open BEFORE registering this one, so a popup
    // never asks itself to close.
    for (const other of [...openPopups]) other();
    openPopups.add(close);

    const isInside = (target: Node | null) =>
      !!target &&
      (!!wrapRef.current?.contains(target) ||
        insideRef.current.some((r) => !!r.current?.contains(target)));

    const onPointerDown = (e: MouseEvent) => {
      if (!isInside(e.target as Node | null)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };

    // Capture phase: a popup must still close when the click lands on something
    // that stops propagation on its way up, or on a control that unmounts
    // itself before the event reaches the document.
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      openPopups.delete(close);
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return wrapRef;
}
