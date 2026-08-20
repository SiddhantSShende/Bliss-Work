import EmojiPicker, { EmojiStyle, Theme } from "emoji-picker-react";
import { useEffect, useRef, useState } from "react";
import { Smile } from "lucide-react";

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
        className="flex h-11 w-11 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg"
        title="Insert an emoji"
        aria-label="Insert an emoji"
        aria-expanded={open}
      >
        <Smile size={18} />
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
    <div className={className}>
      <EmojiPicker
        onEmojiClick={(emoji) => onPick(emoji.emoji)}
        emojiStyle={EmojiStyle.NATIVE}
        theme={Theme.LIGHT}
        width="min(350px, calc(100vw - 1rem))"
        height={420}
        previewConfig={{ showPreview: false }}
        lazyLoadEmojis
      />
    </div>
  );
}
