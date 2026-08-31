/**
 * The overflow for the controls that don't earn a permanent seat in the
 * sidebar: copying the invite link, picture-in-picture, and minimising.
 * PiP/minimise are gated by their own condition exactly as they were before
 * this moved them here (PiP only where supported, minimise only where
 * there's a session to minimise into) — Add People and Recording used to
 * live in this menu too, but the redesign gave both their own first-class
 * sidebar buttons, so this only holds what's left over. The invite link is
 * normally available (unlike PiP/minimise), so unlike those two it's always
 * rendered — just disabled, with a tooltip, when the call doesn't support it.
 *
 * Opens to the RIGHT of its trigger, not up/down — its only home now is the
 * left sidebar, so up/down would run the panel into the control above or
 * below it instead of out into open space.
 */
import { useState } from "react";
import { Link2, Minimize2, MoreHorizontal, PictureInPicture2 } from "lucide-react";
import { usePopupDismiss } from "../lib/usePopupDismiss";
import { SidebarButton } from "./SidebarButton";

export function CallMoreMenu({
  canInviteLink,
  inviteLinkTitle,
  mintingInviteLink,
  onCopyInviteLink,
  pipSupported,
  pipActive,
  onTogglePip,
  onMinimize,
}: {
  canInviteLink: boolean;
  inviteLinkTitle: string;
  mintingInviteLink: boolean;
  onCopyInviteLink: () => void;
  pipSupported: boolean;
  pipActive: boolean;
  onTogglePip: () => void;
  /** Omitted where there's nowhere to minimise into — the button this menu
   *  offers it through is gated the same way. */
  onMinimize?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = usePopupDismiss<HTMLDivElement>(open, () => setOpen(false));

  /** Every row closes the menu first — each one fires an action, and neither
   *  wants the panel left behind. */
  const pick = (run: () => void) => () => {
    setOpen(false);
    run();
  };

  // Nothing to offer at all — omit the button entirely rather than showing
  // one that opens onto an empty panel.
  if (!pipSupported && !onMinimize && !canInviteLink) return null;

  return (
    <div ref={wrap} className="relative">
      <SidebarButton
        icon={<MoreHorizontal size={20} />}
        label="More"
        active={open}
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <div
          role="menu"
          aria-label="More call options"
          className="absolute left-full top-0 z-50 ml-2 w-52 overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-card"
        >
          <MenuItem
            icon={<Link2 size={15} />}
            label="Copy invite link"
            onClick={pick(onCopyInviteLink)}
            disabled={!canInviteLink || mintingInviteLink}
            title={canInviteLink ? "Copy invite link" : inviteLinkTitle}
          />
          {pipSupported && (
            <MenuItem
              icon={<PictureInPicture2 size={15} />}
              label={pipActive ? "Exit picture-in-picture" : "Picture-in-picture"}
              onClick={pick(onTogglePip)}
            />
          )}
          {onMinimize && (
            <MenuItem icon={<Minimize2 size={15} />} label="Minimise" onClick={pick(onMinimize)} />
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  disabled = false,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title ?? label}
      aria-label={title ?? label}
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-fg transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span className="shrink-0 text-muted">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}
