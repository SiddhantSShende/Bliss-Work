import { useEffect, useRef, useState } from "react";
import { CornerUpLeft, Forward, MoreHorizontal, SmilePlus, Trash2, EyeOff } from "lucide-react";
import type { ReactionDTO } from "@taskboard/shared";
import { EmojiGrid, QUICK_REACTIONS } from "./EmojiPicker";

/**
 * The per-bubble action affordance.
 *
 * This replaced a lone hover "Forward" button. Everything else a message can
 * have done to it — reply, react, hide, delete — had no home at all, and adding
 * four more hover icons to a chat bubble is how a thread becomes unreadable. So
 * there is one quick reaction row (the six people actually send) and one
 * overflow menu.
 *
 * "Delete for me" and "Delete for everyone" are deliberately worded in full
 * rather than collapsed into one "Delete": they do genuinely different things,
 * and a user who picks the wrong one cannot undo it.
 */
export function MessageActions({
  mine,
  canForward,
  onReply,
  onForward,
  onReact,
  onHide,
  onDeleteForAll,
}: {
  mine: boolean;
  /** Forward is offered per-surface; channels and threads differ. */
  canForward: boolean;
  onReply?: () => void;
  onForward?: () => void;
  onReact?: (emoji: string) => void;
  /** "Delete for me" — either party, any message. */
  onHide?: () => void;
  /** "Delete for everyone" — sender only; the server enforces it too. */
  onDeleteForAll?: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const [emoji, setEmoji] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu && !emoji) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) {
        setMenu(false);
        setEmoji(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(false);
        setEmoji(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu, emoji]);

  const item =
    "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-fg transition-colors hover:bg-surface-2";

  return (
    <div ref={wrap} className="relative shrink-0">
      {/* Hidden until hover or keyboard focus, so a thread at rest is just the
          conversation. focus-visible keeps it reachable without a mouse. */}
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        {onReact && (
          <button
            onClick={() => { setEmoji((v) => !v); setMenu(false); }}
            title="React"
            aria-label="React to this message"
            className="rounded-full p-1 text-muted hover:bg-surface-2 hover:text-fg"
          >
            <SmilePlus size={13} />
          </button>
        )}
        <button
          onClick={() => { setMenu((v) => !v); setEmoji(false); }}
          title="More"
          aria-label="Message actions"
          aria-expanded={menu}
          className="rounded-full p-1 text-muted hover:bg-surface-2 hover:text-fg"
        >
          <MoreHorizontal size={13} />
        </button>
      </div>

      {emoji && onReact && (
        <div className={`absolute z-20 ${mine ? "right-0" : "left-0"} bottom-7`}>
          <div className="mb-1 flex gap-0.5 rounded-full border border-border bg-surface p-1 shadow-soft">
            {QUICK_REACTIONS.map((e) => (
              <button
                key={e}
                onClick={() => { onReact(e); setEmoji(false); }}
                title={e}
                className="rounded-full px-1.5 py-0.5 text-base leading-none hover:bg-surface-2"
              >
                {e}
              </button>
            ))}
          </div>
          <EmojiGrid onPick={(e) => { onReact(e); setEmoji(false); }} />
        </div>
      )}

      {menu && (
        <div
          role="menu"
          className={`absolute z-20 ${mine ? "right-0" : "left-0"} bottom-7 w-52 rounded-xl border border-border bg-surface p-1 shadow-soft`}
        >
          {onReply && (
            <button role="menuitem" className={item} onClick={() => { onReply(); setMenu(false); }}>
              <CornerUpLeft size={13} className="text-muted" /> Reply
            </button>
          )}
          {canForward && onForward && (
            <button role="menuitem" className={item} onClick={() => { onForward(); setMenu(false); }}>
              <Forward size={13} className="text-muted" /> Forward
            </button>
          )}
          {onHide && (
            <button role="menuitem" className={item} onClick={() => { onHide(); setMenu(false); }}>
              <EyeOff size={13} className="text-muted" /> Delete for me
            </button>
          )}
          {/* Sender only. Hidden rather than disabled on someone else's message:
              a greyed-out "Delete for everyone" on a message you didn't write
              reads as a permission you might have, which you never will. */}
          {mine && onDeleteForAll && (
            <button
              role="menuitem"
              className={`${item} text-danger hover:bg-danger/10`}
              onClick={() => { onDeleteForAll(); setMenu(false); }}
            >
              <Trash2 size={13} /> Delete for everyone
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The reaction tally under a bubble. A chip the caller is part of renders
 * pressed, and clicking it toggles — the same gesture adds and removes, which
 * is what every chat app has taught people to expect.
 */
export function ReactionChips({
  reactions,
  onToggle,
}: {
  reactions: ReactionDTO[];
  onToggle: (emoji: string, on: boolean) => void;
}) {
  if (reactions.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          onClick={() => onToggle(r.emoji, !r.mine)}
          title={r.mine ? "Remove your reaction" : "React"}
          aria-pressed={r.mine}
          className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] leading-none transition-colors ${
            r.mine
              ? "bg-accent-soft text-accent ring-1 ring-accent/40"
              : "bg-surface-2 text-muted hover:text-fg"
          }`}
        >
          <span className="text-sm leading-none">{r.emoji}</span>
          {r.count > 1 && <span className="font-medium">{r.count}</span>}
        </button>
      ))}
    </div>
  );
}
