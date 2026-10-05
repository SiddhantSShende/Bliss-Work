import { useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  CornerUpLeft,
  Download,
  Forward,
  MoreHorizontal,
  MailOpen,
  Pin,
  PinOff,
  SmilePlus,
  Trash2,
  EyeOff,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ReactionDTO } from "@taskboard/shared";
import { usePopupDismiss } from "../lib/usePopupDismiss";
import { usePopoverPosition } from "../lib/usePopoverPosition";
import { ConfirmDialog } from "./ConfirmDialog";
import { EmojiGrid, EmojiPopup, QUICK_REACTIONS } from "./EmojiPicker";
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
  containerRef,
  files,
  onDownload,
  forwardHref,
  onReply,
  onForwardTo,
  onForward,
  onReact,
  onHide,
  onMarkUnread,
  onDeleteForAll,
  canDeleteForAll,
  pinned,
  onTogglePin,
}: {
  mine: boolean;
  /**
   * The thread's scroll container. The overflow menu is portalled (see
   * `menuRef` below — the same reason `EmojiPopup` is), so its placement has
   * to be measured against something; anchoring that measurement to the
   * viewport instead of this container is what let the menu flip "above" a
   * message near the top of the thread and land behind the fixed chat
   * header, which sits above the container but is still inside the viewport.
   */
  containerRef: RefObject<HTMLDivElement | null>;
  /**
   * The files this message carries, if any. Each one gets its own "Download"
   * entry (a lone file just "Download", several name theirs) — the explicit,
   * deliberate download, and the only one: clicking the file itself opens it.
   */
  files?: ReadonlyArray<{ id: string; name: string }>;
  /** Download one of `files`. Absent (with `files`) where downloading is not offered. */
  onDownload?: (file: { id: string; name: string }) => void;
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
  /** Marks this message and everything after it as unread. */
  onMarkUnread?: () => void;
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
  const { t } = useTranslation("chatThread");
  const [menu, setMenu] = useState(false);
  const [emoji, setEmoji] = useState(false);
  // Which destructive confirm to show, if any. Neither delete fires on click
  // any more — a stray tap that removes a message with no way back is exactly
  // the mistake a confirm step exists to catch.
  const [confirm, setConfirm] = useState<"hide" | "deleteAll" | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // ONE registration for both panels, because they share a wrapper and only one
  // of them is ever open: each trigger closes the other, so "is anything open
  // here" is the state that dismissal cares about.
  const wrap = usePopupDismiss<HTMLDivElement>(
    menu || emoji,
    () => {
      setMenu(false);
      setEmoji(false);
    },
    // Both panels are portalled (see menuRef/popupRef's own components), so
    // neither is inside `wrap` in the DOM — both have to be listed, or
    // clicking inside either one reads as an outside click and closes it.
    [popupRef, menuRef],
  );
  // Prefers above (today's default), flipping to below only when the message
  // is close enough to the top of the scroll container that the menu would
  // not fit above it. Aligned to the trigger's right edge for `mine`
  // messages (whose row is right-aligned) and its left edge otherwise —
  // matching the menu's previous `right-0`/`left-0` placement.
  const menuStyle = usePopoverPosition({
    anchor: wrap,
    panelRef: menuRef,
    boundary: containerRef,
    preferred: "above",
    align: mine ? "end" : "start",
    active: menu,
  });

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
            title={t("messageActions.react.title")}
            aria-label={t("messageActions.react.ariaLabel")}
            className="rounded-full p-1 text-muted hover:bg-surface-2 hover:text-fg"
          >
            <SmilePlus size={13} />
          </button>
        )}
        <button
          onClick={() => { setMenu((v) => !v); setEmoji(false); }}
          title={t("messageActions.more.title")}
          aria-label={t("messageActions.more.ariaLabel")}
          aria-expanded={menu}
          className="rounded-full p-1 text-muted hover:bg-surface-2 hover:text-fg"
        >
          <MoreHorizontal size={13} />
        </button>
      </div>

      {emoji && onReact && (
        <EmojiPopup anchor={wrap} popupRef={popupRef}>
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
        </EmojiPopup>
      )}

      {menu && typeof document !== "undefined" && createPortal(
        <div
          ref={menuRef}
          role="menu"
          // Portalled to document.body and positioned in fixed coordinates
          // via menuStyle (see usePopoverPosition) — same reason as
          // EmojiPopup: a panel positioned inside the thread's scroll box is
          // clipped by it, which is what let this menu render half-hidden
          // behind the chat header for a message near the top of the thread.
          className="fixed z-[1100] w-52 overflow-y-auto overscroll-contain rounded-xl border border-border bg-surface p-1 shadow-soft"
          style={menuStyle}
        >
          {onReply && (
            <button role="menuitem" className={item} onClick={() => { onReply(); setMenu(false); }}>
              <CornerUpLeft size={13} className="text-muted" /> {t("messageActions.menu.reply")}
            </button>
          )}
          {onDownload &&
            files?.map((file) => (
              <button
                key={file.id}
                role="menuitem"
                className={item}
                onClick={() => { onDownload(file); setMenu(false); }}
              >
                <Download size={13} className="text-muted shrink-0" />
                <span className="min-w-0 truncate">
                  {files.length === 1
                    ? t("messageActions.menu.download")
                    : t("messageActions.menu.downloadNamed", { name: file.name })}
                </span>
              </button>
            ))}
          {onForwardTo && (
            <button
              role="menuitem"
              className={item}
              onClick={() => { onForwardTo(); setMenu(false); }}
            >
              <Forward size={13} className="text-muted" /> {t("messageActions.menu.forwardTo")}
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
              <WhatsAppIcon size={13} className="text-[#25D366]" /> {t("messageActions.menu.forwardWhatsApp")}
            </a>
          )}
          {onMarkUnread && (
            <button role="menuitem" className={item} onClick={() => { onMarkUnread(); setMenu(false); }}>
              <MailOpen size={13} className="text-muted" /> {t("messageActions.menu.markUnread")}
            </button>
          )}
          {onHide && (
            <button role="menuitem" className={item} onClick={() => { setMenu(false); setConfirm("hide"); }}>
              <EyeOff size={13} className="text-muted" /> {t("messageActions.menu.deleteForMe")}
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
                <><PinOff size={13} className="text-muted" /> {t("messageActions.menu.unpinForEveryone")}</>
              ) : (
                <><Pin size={13} className="text-muted" /> {t("messageActions.menu.pinForEveryone")}</>
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
              onClick={() => { setMenu(false); setConfirm("deleteAll"); }}
            >
              <Trash2 size={13} /> {t("messageActions.menu.deleteForEveryone")}
            </button>
          )}
        </div>,
        document.body,
      )}

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={t("messageActions.confirmDialog.title")}
        message={
          confirm === "deleteAll"
            ? t("messageActions.confirmDialog.deleteAllMessage")
            : t("messageActions.confirmDialog.deleteMeMessage")
        }
        confirmLabel={t("messageActions.confirmDialog.confirmLabel")}
        danger
        onConfirm={() => {
          if (confirm === "hide") onHide?.();
          else if (confirm === "deleteAll") onDeleteForAll?.();
          setConfirm(null);
        }}
      />
    </div>
  );
}

/**
 * Who is behind one chip's tally, as a sentence.
 *
 * A count answers "how many" and stops there, which in a channel is the less
 * useful half — a chip reading 3 is a question you have to ask out loud. The
 * names come from the server (store.reactionColumns), CAPPED, so `count` and
 * the list can legitimately disagree: when they do the remainder is stated
 * rather than the tally quietly shrinking to the names that fit.
 *
 * Falls back to the old wording when there are no names at all, which is what a
 * client holding a cached tally from before reactors existed will have.
 */
function reactorLabel(r: ReactionDTO, t: TFunction): string {
  const action = r.mine ? t("messageActions.reactions.clickToRemove") : t("messageActions.reactions.clickToReact");
  if (!r.reactors || r.reactors.length === 0) return action;
  const named = r.reactors.filter(Boolean);
  if (named.length === 0) return action;
  const hidden = Math.max(0, r.count - named.length);
  const who = hidden > 0 ? t("messageActions.reactions.andMore", { names: named.join(", "), hidden }) : named.join(", ");
  return t("messageActions.reactions.tooltip", { who, emoji: r.emoji, action: action.toLowerCase() });
}

/**
 * The reaction tally under a bubble. A chip the caller is part of renders
 * pressed, and clicking it toggles — the same gesture adds and removes, which
 * is what every chat app has taught people to expect.
 *
 * The reactors are surfaced as the chip's own tooltip rather than as a panel of
 * their own. That keeps the click doing the one thing it has always done: a
 * chip that toggles on click AND opens something on click is a chip where
 * neither gesture is reliable, and the tally sits under every bubble in the
 * thread, so anything with a layout of its own would move the whole
 * conversation.
 */
export function ReactionChips({
  reactions,
  onToggle,
}: {
  reactions: ReactionDTO[];
  onToggle: (emoji: string, on: boolean) => void;
}) {
  const { t } = useTranslation("chatThread");
  if (reactions.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {reactions.map((r) => {
        const label = reactorLabel(r, t);
        return (
          <button
            key={r.emoji}
            onClick={() => onToggle(r.emoji, !r.mine)}
            title={label}
            // The tooltip is the only place the names are written, so the
            // accessible name has to carry them too — `title` alone is not
            // announced consistently, and a chip that reads as "👍 3" to a
            // screen reader is missing exactly what was added here.
            aria-label={label}
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
        );
      })}
    </div>
  );
}
