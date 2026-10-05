import { useState } from "react";
import { CalendarClock, ChevronDown, Link, Phone, Video } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, cn } from "@taskboard/ui";
import { usePopupDismiss } from "../lib/usePopupDismiss";

/**
 * The single call control in a chat header.
 *
 * A voice button and a video button sitting side by side spent two slots of a
 * header that also has to fit a name, a presence line, Block and Ignore — and
 * they only covered two of the four ways a call actually starts. One control
 * with a menu costs one slot and holds all four.
 *
 * Layout follows the navbar's GetAppButton dropdown (trigger + click-away
 * backdrop + absolutely-positioned panel) so the two menus in the app behave
 * the same way.
 *
 * `onSendLink` is optional because a channel call has no link to send: the
 * channel IS the guest list and the server refuses to mint one, so that row is
 * ABSENT there rather than present and failing.
 */
export function CallMenu({
  onVoiceCall,
  onVideoCall,
  onSendLink,
  onSchedule,
  busy = false,
  className,
}: {
  onVoiceCall: () => void;
  onVideoCall: () => void;
  /** Mint a join link and send it into this conversation. Omit where a link is
   *  meaningless — the row is then not rendered at all. */
  onSendLink?: () => void;
  /** Open the scheduler for a call later on. */
  onSchedule: () => void;
  /** A link is being minted — the menu stays usable, that one row does not. */
  busy?: boolean;
  /** Trigger styling, for a header whose other icon buttons are not ghost
   *  Buttons. The menu panel itself is unaffected. */
  className?: string;
}) {
  const { t } = useTranslation("calls");
  const [open, setOpen] = useState(false);
  const wrap = usePopupDismiss<HTMLDivElement>(open, () => setOpen(false));

  /** Every row closes the menu first: each one either navigates away, opens a
   *  dialog, or fires a request, and none of them wants the panel left behind. */
  const pick = (run: () => void) => () => {
    setOpen(false);
    run();
  };

  return (
    <div ref={wrap} className="relative">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        className={className}
        title={t("menu.call")}
        aria-label={t("menu.call")}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Phone size={15} />
        <ChevronDown size={14} className={cn("transition-transform", open && "rotate-180")} />
      </Button>
      {open && (
        // No click-away backdrop any more. A `fixed inset-0` layer dismissed
        // this menu but also SWALLOWED the click that dismissed it, so reaching
        // any other control took two presses — and it left every other popup on
        // screen open, since a backdrop only knows about its own menu. Outside
        // clicks, Escape and the one-popup-at-a-time rule all come from
        // usePopupDismiss now.
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1.5 w-56 overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-card"
        >
          <Item icon={<Phone size={15} />} label={t("menu.voiceCall")} onClick={pick(onVoiceCall)} />
          <Item icon={<Video size={15} />} label={t("menu.videoCall")} onClick={pick(onVideoCall)} />
          {onSendLink && (
            <Item
              icon={<Link size={15} />}
              label={t("menu.sendCallLink")}
              onClick={pick(onSendLink)}
              disabled={busy}
            />
          )}
          <Item
            icon={<CalendarClock size={15} />}
            label={t("menu.scheduleCall")}
            onClick={pick(onSchedule)}
          />
        </div>
      )}
    </div>
  );
}

function Item({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-fg transition-colors hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-55"
    >
      <span className="text-muted">{icon}</span>
      <span className="font-medium">{label}</span>
    </button>
  );
}
