import { useEffect, useRef, useState } from "react";
import {
  CornerUpLeft,
  Forward,
  MoreHorizontal,
  Pin,
  PinOff,
  SmilePlus,
  Trash2,
  EyeOff,
} from "lucide-react";
import type { ReactionDTO } from "@taskboard/shared";
import { EmojiGrid, QUICK_REACTIONS } from "./EmojiPicker";
import { WhatsAppIcon } from "./WhatsAppIcon";

/**
 * The per-bubble action affordance.
 *
 * Everything a message can have done to it — reply, react, hide, delete — needs
 * a home, and adding an icon per action to a chat bubble is how a thread becomes
 * unreadable. So there is one quick reaction row (the six people actually send)
 * and one overflow menu.
 *
 * "Delete for me" and "Delete for everyone" are deliberately worded in full
 * rather than collapsed into one "Delete": they do genuinely different things,
 * and a user who picks the wrong one cannot undo it.
 */
export function MessageActions({
  mine,
  forwardHref,
  onReply,
  onForwardTo,
  onForward,
  onReact,
  onHide,
  onDeleteForAll,
  canDeleteForAll,
  pinned,
  onTogglePin,
}: {
  mine: boolean;
  /**
   * The wa.me URL this message forwards to, or undefined to hide the action
   * (offered per-surface; channels and threads differ).
   *
   * A real href on a real anchor, NOT a scripted window.open: navigation has to
   * be the browser's own response to the click or a popup blocker eats it, and
   * in Electron an anchor routes through setWindowOpenHandler → safeExternalUrl
   * → shell.openExternal, so the desktop app hands off to the system browser
   * instead of opening a renderer window.
   */
  forwardHref?: string;
  onReply?: () => void;
  /**
   * Opens the in-workspace forward picker — another person's chat, or a
   * channel.
   *
   * Listed FIRST of the two forward actions because it is the only one that
   * delivers anything: the server writes the copy and re-scopes the files it
   * carries, so a forwarded photo opens for the recipient. The WhatsApp entry
   * below it hands the message to another app and can only record that it
   * opened.
   */
  onForwardTo?: () => void;
  /**
   * Fired on the same click that navigates. It ARMS the record rather than
   * writing it — useWhatsAppForward posts only once the user comes back, so a
   * blocked popup or an instant bounce off the WhatsApp login wall leaves no
   * trace in the thread.
   */
  onForward?: () => void;
  onReact?: (emoji: string) => void;
  /** "Delete for me" — either party, any message. */
  onHide?: () => void;
  /** "Delete for everyone" — the server enforces who may, `canDeleteForAll`
   *  only decides whether to offer it. */
  onDeleteForAll?: () => void;
  /**
   * Whether to offer "Delete for everyone". Defaults to `mine`, which is the
   * DM rule: only the author may retract.
   *
   * A channel widens it — an owner, channel admin or org_admin may remove
   * anyone's message, because a channel is a shared space and moderating it is
   * the point. Passed in rather than derived here because this component has no
   * idea which surface it is on, let alone what the caller's role in it is.
   */
  canDeleteForAll?: boolean;
  /** Current pin state, so the entry reads "Pin" or "Unpin". */
  pinned?: boolean;
  /** Pin/unpin for everyone. Absent where pinning does not apply (DMs) or where
   *  the caller may not moderate — the server enforces it either way. */
  onTogglePin?: () => void;
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
          {onForwardTo && (
            <button
              role="menuitem"
              className={item}
              onClick={() => { onForwardTo(); setMenu(false); }}
            >
              <Forward size={13} className="text-muted" /> Forward to chat or channel…
            </button>
          )}
          {forwardHref && (
            // An anchor, not a button — see forwardHref. onForward only arms the
            // record on this click; nothing is posted until the user returns
            // from WhatsApp, so nothing here can delay opening it.
            <a
              role="menuitem"
              className={item}
              href={forwardHref}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => { onForward?.(); setMenu(false); }}
            >
              <WhatsAppIcon size={13} className="text-[#25D366]" /> Forward to WhatsApp
            </a>
          )}
          {onHide && (
            <button role="menuitem" className={item} onClick={() => { onHide(); setMenu(false); }}>
              <EyeOff size={13} className="text-muted" /> Delete for me
            </button>
          )}
          {/* "Pin for everyone" — moderators only, so the caller simply does not
              pass onTogglePin when they cannot. Above the destructive entries
              because it is the one non-destructive thing in this group. */}
          {onTogglePin && (
            <button
              role="menuitem"
              className={item}
              onClick={() => { onTogglePin(); setMenu(false); }}
            >
              {pinned ? (
                <><PinOff size={13} className="text-muted" /> Unpin for everyone</>
              ) : (
                <><Pin size={13} className="text-muted" /> Pin for everyone</>
              )}
            </button>
          )}
          {/* Hidden rather than disabled where it does not apply: a greyed-out
              "Delete for everyone" on a message you cannot delete reads as a
              permission you might have, which you never will.

              `canDeleteForAll ?? mine` keeps the DM rule (author only) as the
              default and lets a channel widen it to its moderators. */}
          {(canDeleteForAll ?? mine) && onDeleteForAll && (
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
