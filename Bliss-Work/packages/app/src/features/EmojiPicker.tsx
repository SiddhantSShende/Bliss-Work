import EmojiPicker, { EmojiStyle, Theme } from "emoji-picker-react";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Smile } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTheme } from "@taskboard/ui";
import { usePopupDismiss } from "../lib/usePopupDismiss";
import { usePopoverPosition } from "../lib/usePopoverPosition";

/**
 * Emoji selection shared by composers and message reactions.
 *
 * The picker uses native Unicode glyphs, so the operating system supplies the
 * same broad catalog and visual style people already know from their phone.
 *
 * The list is the ONLY thing to change if the set turns out to be wrong; the
 * server takes an arbitrary emoji string (bounded and control-char-filtered),
 * so growing the palette needs no migration and no API change.
 */

/** The one-tap row offered on a message bubble. Ordered by how often each is
 *  actually used as a reaction, so the common ones need no aiming. */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "😮", "🙏"] as const;

/**
 * The emoji panel, positioned against its trigger and kept inside the window.
 *
 * ── Portalled, because the thread clips ─────────────────────────────────────
 * The composer and every message bubble sit inside the thread's scroll box. A
 * panel positioned inside that box is clipped by it, so the picker opened over
 * a bubble near the top of the list came out half-drawn. Rendering to
 * document.body takes it out of that box; `fixed` coordinates against the
 * viewport are then the honest way to place it.
 *
 * ── Measured, not guessed ───────────────────────────────────────────────────
 * This used to take the panel's height as a NUMBER from the caller — 420 in the
 * composer, 465 on a message, both hard-coded guesses at what the grid would
 * render as. A guess that runs low places the panel too close to the anchor and
 * it covers the composer; one that runs high wastes the space it was supposed to
 * be fitting into. Both call sites had to keep their guess in step with the
 * grid's real height, and neither did.
 *
 * So the panel is mounted hidden, measured once for real, and only then placed.
 * The measure/place pass is a LAYOUT effect, so it completes before the browser
 * paints and there is no frame where the panel is visible in the wrong place.
 *
 * `maxHeight` is the other half of not covering the composer: when neither side
 * of the anchor has room for the whole grid, the panel scrolls internally
 * instead of overhanging the message list and the input.
 */
export function EmojiPopup({
  anchor,
  popupRef,
  children,
}: {
  anchor: React.RefObject<HTMLElement | null>;
  /** Owned by the caller, which needs it to tell "inside the popup" from
   *  "outside" — the panel is portalled, so it is not inside the trigger's
   *  wrapper in the DOM. See lib/usePopupDismiss. */
  popupRef: React.RefObject<HTMLDivElement | null>;
  children: React.ReactNode;
}) {
  // Below when it actually fits below, otherwise whichever side has more
  // room. A composer sits at the bottom of the window, so this resolves to
  // "above" there; a message near the top of the thread resolves to "below".
  const style = usePopoverPosition({ anchor, panelRef: popupRef, preferred: "below" });

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={popupRef}
      // Above the app's own layers (the tallest elsewhere is z-[1000], on
      // ConversationMenu) — a picker that opens behind the menu that summoned
      // it is not a picker.
      className="fixed z-[1100] overflow-y-auto overscroll-contain rounded-xl"
      style={style}
    >
      {children}
    </div>,
    document.body,
  );
}

/**
 * Composer emoji button. Inserts at the end of the current text — not at the
 * caret, because the textarea is uncontrolled from here and reaching into its
 * selection would couple the two components for a gain nobody has asked for.
 */
export function EmojiPickerButton({ onPick }: { onPick: (emoji: string) => void }) {
  const { t } = useTranslation("chatMedia");
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  // The wrapper holds the trigger, so pressing it again closes rather than
  // being treated as an outside click. The portalled panel is declared inside
  // too — see lib/usePopupDismiss.
  const wrap = usePopupDismiss<HTMLDivElement>(open, () => setOpen(false), [popupRef]);

  return (
    <div ref={wrap} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-11 w-11 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg"
        title={t("emojiPicker.insertEmoji")}
        aria-label={t("emojiPicker.insertEmoji")}
        aria-expanded={open}
      >
        <Smile size={18} />
      </button>
      {open && (
        <EmojiPopup anchor={wrap} popupRef={popupRef}>
          <EmojiGrid
            onPick={(e) => {
              onPick(e);
              setOpen(false);
            }}
          />
        </EmojiPopup>
      )}
    </div>
  );
}

/** The grid itself — shared by the composer button and the reaction menu. */
export function EmojiGrid({
  onPick,
  className = "",
}: {
  onPick: (emoji: string) => void;
  className?: string;
}) {
  const { isDark } = useTheme();

  return (
    <div className={className}>
      <EmojiPicker
        onEmojiClick={(emoji) => onPick(emoji.emoji)}
        emojiStyle={EmojiStyle.NATIVE}
        theme={isDark ? Theme.DARK : Theme.LIGHT}
        width="min(350px, calc(100vw - 1rem))"
        height={420}
        previewConfig={{ showPreview: false }}
        lazyLoadEmojis
      />
    </div>
  );
}
