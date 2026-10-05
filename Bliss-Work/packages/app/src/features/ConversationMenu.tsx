/**
 * The overflow menu on a conversation header — one component for a chat and for
 * a channel.
 *
 * Both headers ask the same five questions of a conversation (who is this, find
 * something in it, what has been shared in it, stop it interrupting me, and
 * everything rarer than that), so both get the same menu rather than two that
 * drift. A channel additionally carries the rows that manage the channel
 * itself; those are passed in and rendered as their own group, below a
 * separator, so leaving a channel never sits next to exporting one.
 *
 * "More" EXPANDS IN PLACE. It is a disclosure inside this panel, not a second
 * menu: a submenu that opens beside a right-aligned panel has nowhere to go on
 * a narrow window, and stacking one popup on another is how a menu becomes
 * impossible to dismiss on touch. The disclosure collapses again whenever the
 * menu closes, so re-opening always starts from the short list.
 *
 * Layout follows CallMenu and the ChannelMenu it replaces (trigger +
 * click-away backdrop + absolutely positioned panel) so every menu in the app
 * behaves the same way.
 */
import { useState } from "react";
import {
  Bell,
  BellOff,
  ChevronDown,
  Download,
  Eraser,
  Images,
  ListChecks,
  LogOut,
  MoreVertical,
  Pencil,
  Pin,
  Search,
  Trash2,
  User,
  Users,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@taskboard/ui";
import { usePopupDismiss } from "../lib/usePopupDismiss";

export interface ConversationMenuProps {
  /** Which surface this is. Decides the trigger's label and the profile row's
   *  icon — a chat's profile is a person, a channel's is its membership. */
  scope: "chat" | "channel";
  /** The peer's profile page, or the channel's members. */
  onViewProfile: () => void;
  /** Open the in-conversation search field. */
  onSearch: () => void;
  /** Open the media / documents / links panel. */
  onMedia: () => void;
  /** Muted on THIS DEVICE — see lib/conversationPrefs. */
  muted: boolean;
  onToggleMute: () => void;
  /** Pinned to the top of the list on this device. */
  shortcut: boolean;
  onToggleShortcut: () => void;
  /** Download the loaded conversation as a transcript. */
  onExport: () => void;
  /**
   * Enter multi-message selection mode. Same contract as `onClearChat`: omit
   * it and the row renders inert with UNAVAILABLE_HINT rather than opening a
   * mode nothing backs.
   */
  onSelectMessages?: () => void;
  /**
   * Clear this conversation for the caller. OMIT while nothing backs it: the
   * row then renders disabled with UNAVAILABLE_HINT rather than half-clearing
   * the page that happens to be loaded and calling it done.
   */
  onClearChat?: () => void;
  /** Leave this channel. Confirmation is the caller's, not the menu's. Its
   *  presence is what makes this a channel menu. */
  onLeave?: () => void;
  /** A leave request is in flight — that one row is disabled, the menu is not. */
  leaving?: boolean;
  /** Rename this channel. Same contract as `onClearChat`. */
  onRename?: () => void;
  /** Delete this channel. Same contract as `onClearChat`. */
  onDelete?: () => void;
  /** Trigger styling, for a header whose other icon buttons are not ghost
   *  Buttons. The menu panel itself is unaffected. */
  className?: string;
}

export function ConversationMenu({
  scope,
  onViewProfile,
  onSearch,
  onMedia,
  muted,
  onToggleMute,
  shortcut,
  onToggleShortcut,
  onExport,
  onSelectMessages,
  onClearChat,
  onLeave,
  leaving = false,
  onRename,
  onDelete,
  className,
}: ConversationMenuProps) {
  const { t } = useTranslation("chatThread");
  // Said on the row itself, because a disabled row with no explanation reads as
  // a bug. Matches the wording the channel rows have carried since they were
  // first rendered inert.
  const unavailableHint = t("conversationMenu.unavailableHint");
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const close = () => {
    setOpen(false);
    // Collapsed for next time: the point of the disclosure is that the menu is
    // short until someone asks for the rest of it.
    setExpanded(false);
  };

  const wrap = usePopupDismiss<HTMLDivElement>(open, close);

  /** Every row except More either navigates, opens a panel or fires a request;
   *  none of them wants the menu left behind. */
  const pick = (run: () => void) => () => {
    close();
    run();
  };

  const label = scope === "channel" ? t("conversationMenu.label.channel") : t("conversationMenu.label.chat");

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className={
          className ??
          "flex items-center rounded-lg px-1.5 py-1 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        }
      >
        <MoreVertical size={16} />
      </button>
      {open && (
        <>
          {/* The click-away backdrop that used to sit here is gone. At
              `fixed inset-0 z-[999]` it covered the entire app, so a click
              meant for any other control was eaten dismissing this menu and
              had to be repeated — and because a backdrop only ever closes its
              own menu, anything else already open stayed open behind it.
              usePopupDismiss handles outside clicks, Escape, and closing
              whatever else was open, without a layer over the page. */}
          {/* z-1000 deliberately clears every other layer in the app — the
              tallest elsewhere is z-[200]. This menu opens over a message list
              that renders images, video, file cards and map previews, and a
              menu that appears BEHIND the photo it is anchored next to is not a
              menu.

              The height cap is what keeps the expanded form usable on a short
              window: eleven rows is taller than a laptop browser's viewport
              once the disclosure is open, and a panel that runs off the bottom
              of the screen takes its last rows with it. */}
          <div
            role="menu"
            aria-label={label}
            className="absolute right-0 z-[1000] mt-1.5 max-h-[70dvh] w-56 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-card"
          >
            <Item
              icon={scope === "channel" ? <Users size={15} /> : <User size={15} />}
              label={t("conversationMenu.items.viewProfile")}
              onClick={pick(onViewProfile)}
            />
            <Item icon={<Search size={15} />} label={t("conversationMenu.items.search")} onClick={pick(onSearch)} />
            <Item
              icon={<Images size={15} />}
              label={t("conversationMenu.items.media")}
              onClick={pick(onMedia)}
            />
            <Item
              icon={<ListChecks size={15} />}
              label={t("conversationMenu.items.selectMessages")}
              onClick={onSelectMessages ? pick(onSelectMessages) : undefined}
              hint={onSelectMessages ? undefined : unavailableHint}
            />
            <Item
              icon={muted ? <BellOff size={15} /> : <Bell size={15} />}
              label={muted ? t("conversationMenu.items.unmute") : t("conversationMenu.items.mute")}
              onClick={pick(onToggleMute)}
            />

            <Item
              icon={
                <ChevronDown
                  size={15}
                  className={cn("transition-transform", expanded && "rotate-180")}
                />
              }
              label={t("conversationMenu.items.more")}
              expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            />
            {expanded && (
              // Inset and ruled so the three rows read as belonging to More
              // rather than as four more peers of it.
              <div className="ml-3.5 border-l border-border pl-1">
                <Item
                  icon={<Eraser size={15} />}
                  label={t("conversationMenu.items.clearChat")}
                  onClick={onClearChat ? pick(onClearChat) : undefined}
                  hint={onClearChat ? undefined : unavailableHint}
                  danger
                />
                <Item
                  icon={<Download size={15} />}
                  label={t("conversationMenu.items.exportChat")}
                  onClick={pick(onExport)}
                />
                <Item
                  icon={<Pin size={15} />}
                  label={
                    shortcut
                      ? t("conversationMenu.items.unpin", {
                          scope: t(scope === "channel" ? "conversationMenu.scope.channel" : "conversationMenu.scope.chat"),
                        })
                      : t("conversationMenu.items.pin", {
                          scope: t(scope === "channel" ? "conversationMenu.scope.channel" : "conversationMenu.scope.chat"),
                        })
                  }
                  onClick={pick(onToggleShortcut)}
                />
              </div>
            )}

            {onLeave && (
              <>
                <div className="my-1 h-px bg-border" role="separator" />
                <Item
                  icon={<Pencil size={15} />}
                  label={t("conversationMenu.items.rename")}
                  onClick={onRename ? pick(onRename) : undefined}
                  hint={onRename ? undefined : unavailableHint}
                />
                <Item
                  icon={<Trash2 size={15} />}
                  label={t("conversationMenu.items.delete")}
                  onClick={onDelete ? pick(onDelete) : undefined}
                  hint={onDelete ? undefined : unavailableHint}
                  danger
                />
                <Item
                  icon={<LogOut size={15} />}
                  label={leaving ? t("conversationMenu.items.leaving") : t("conversationMenu.items.leave")}
                  onClick={leaving ? undefined : pick(onLeave)}
                  danger
                />
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One menu row.
 *
 * A missing `onClick` is what disables the row — the caller decides a capability
 * is absent by not passing a handler, so there is no way to render an enabled
 * row that does nothing. `hint` rides on a WRAPPER span because a disabled
 * button fires no mouse events and its own `title` would never surface.
 */
function Item({
  icon,
  label,
  onClick,
  hint,
  expanded,
  danger = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  hint?: string;
  /** Set on the disclosure row only; every other row opens nothing. */
  expanded?: boolean;
  danger?: boolean;
}) {
  const button = (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={!onClick}
      aria-expanded={expanded}
      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors disabled:pointer-events-none disabled:opacity-45 ${
        danger ? "text-danger hover:bg-danger/10" : "text-fg hover:bg-surface-2"
      }`}
    >
      <span className={danger ? "" : "text-muted"}>{icon}</span>
      <span className="font-medium">{label}</span>
    </button>
  );
  return onClick || !hint ? button : <span title={hint}>{button}</span>;
}
