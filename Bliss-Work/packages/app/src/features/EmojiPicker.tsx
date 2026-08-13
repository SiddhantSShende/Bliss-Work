import { useEffect, useRef, useState } from "react";
import { Smile } from "lucide-react";

/**
 * A small, built-in emoji palette.
 *
 * NO DEPENDENCY, deliberately. Every off-the-shelf picker ships a full Unicode
 * index and, usually, a sprite sheet or a remote CDN image set — hundreds of
 * kilobytes for a feature whose realistic use is a dozen glyphs, and the remote
 * variants are simply blocked outright by the desktop shell's CSP. This is a
 * curated grid of the reactions people actually send, plus a composer button
 * that inserts into the textarea.
 *
 * The list is the ONLY thing to change if the set turns out to be wrong; the
 * server takes an arbitrary emoji string (bounded and control-char-filtered),
 * so growing the palette needs no migration and no API change.
 */

/** The one-tap row offered on a message bubble. Ordered by how often each is
 *  actually used as a reaction, so the common ones need no aiming. */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "😮", "🙏"] as const;

/** The composer palette. Same glyphs the reaction row uses, plus enough range
 *  to write with. Grouped loosely so the grid is scannable. */
const PALETTE = [
  "👍", "👎", "❤️", "🎉", "😂", "😊", "😉", "😍",
  "🤔", "😅", "😭", "😡", "😮", "🙏", "👏", "🔥",
  "✅", "❌", "⚠️", "💡", "📌", "⏰", "🚀", "💯",
  "👀", "🙌", "🤝", "💪", "☕", "🍕", "🎂", "🌟",
];

/**
 * Composer emoji button. Inserts at the end of the current text — not at the
 * caret, because the textarea is uncontrolled from here and reaching into its
 * selection would couple the two components for a gain nobody has asked for.
 */
export function EmojiPickerButton({ onPick }: { onPick: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // Close on an outside click or Escape. Both, because a picker that only
  // closes one way is a picker that gets stuck open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrap} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-11 w-11 rounded-full text-muted hover:bg-surface-2 hover:text-fg"
        title="Insert an emoji"
        aria-label="Insert an emoji"
        aria-expanded={open}
      >
        <Smile size={18} className="mx-auto" />
      </button>
      {open && (
        <EmojiGrid
          className="absolute bottom-12 left-0 z-20"
          onPick={(e) => {
            onPick(e);
            setOpen(false);
          }}
        />
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
  return (
    <div
      className={`w-64 rounded-2xl border border-border bg-surface p-2 shadow-soft ${className}`}
      role="menu"
    >
      <div className="grid grid-cols-8 gap-0.5">
        {PALETTE.map((e) => (
          <button
            key={e}
            type="button"
            role="menuitem"
            onClick={() => onPick(e)}
            title={e}
            className="rounded-lg p-1 text-lg leading-none transition-colors hover:bg-surface-2"
          >
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}
