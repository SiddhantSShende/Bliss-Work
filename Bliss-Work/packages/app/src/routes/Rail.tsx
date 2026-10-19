import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  BarChart3,
  Mail,
  Calendar,
  MessageSquare,
  ListTodo,
  Hash,
  Users,
  Building2,
  Settings,
  MoreHorizontal,
} from "lucide-react";
import { ProfileMenu } from "../features/ProfileMenu";
import { usePopupDismiss } from "../lib/usePopupDismiss";
import { AnchoredPopover } from "../features/AnchoredPopover";

// Labels are resolved at render time via t(`nav.${key}`) — see buttons()
// below — so this stays a plain module-level constant that doesn't need a
// hook to build.
const ITEMS = [
  { key: "analytics", icon: BarChart3, to: "/app/analytics" },
  { key: "mail", icon: Mail, to: "/app/mail" },
  { key: "meetings", icon: Calendar, to: "/app/meetings" },
  { key: "chats", icon: MessageSquare, to: "/app/chats" },
  { key: "tasks", icon: ListTodo, to: "/app/tasks/allocated" },
  { key: "channels", icon: Hash, to: "/app/channels" },
  { key: "members", icon: Users, to: "/app/members" },
  { key: "org", icon: Building2, to: "/app/org" },
  { key: "settings", icon: Settings, to: "/app/settings" },
] as const;

/** Icon size in the icon-only side rail. 24px keeps a 72px rail from reading as
 *  empty; the bottom bar and the drawer keep their own 20px icon + label. */
const SIDE_ICON_SIZE = 24;

/** The bottom tab bar only has room for a handful of icons+labels before it
 *  reads as cramped rather than compact — these five are the ones a phone
 *  user reaches for constantly; the rest live behind "More". */
const BOTTOM_PRIMARY_KEYS = ["mail", "meetings", "chats", "tasks", "channels"] as const;
const BOTTOM_PRIMARY = ITEMS.filter((it) => (BOTTOM_PRIMARY_KEYS as readonly string[]).includes(it.key));
const BOTTOM_MORE = ITEMS.filter((it) => !(BOTTOM_PRIMARY_KEYS as readonly string[]).includes(it.key));

/**
 * Section navigation, in three shapes:
 * - `side` — the vertical rail on tablet/desktop.
 * - `bottom` — the horizontal tab bar on phones (Mail/Meetings/Chats/Tasks/
 *   Channels + a "More" overflow for Members/Org/Settings), rendered at the
 *   bottom of the shell so it sits under the thumb.
 * - `drawer` — the full labelled list inside the mobile nav drawer
 *   (MobileNavDrawer.tsx). Same items, same active/badge logic, same `nav()`
 *   calls as the other two — nothing about routing/nav state is duplicated.
 */
export function Rail({
  section,
  variant = "side",
  className = "",
  badges = {},
  onSelect,
}: {
  section: string | null;
  variant?: "side" | "bottom" | "drawer";
  className?: string;
  /** Per-section unread/alert counts keyed by item.key (e.g. mail, tasks). A
   *  value > 0 renders a red badge on top of that icon. */
  badges?: Record<string, number>;
  /** Fired after navigating to an item — the mobile drawer uses this to close
   *  itself on selection. Absent for `side`/`bottom`, which have nothing to
   *  close. */
  onSelect?: () => void;
}) {
  const { t } = useTranslation("shell");
  const nav = useNavigate();
  const bottom = variant === "bottom";
  const drawer = variant === "drawer";
  const go = (to: string) => {
    nav(to);
    onSelect?.();
  };
  const side = !bottom && !drawer;
  const buttons = (items: readonly (typeof ITEMS)[number][]) =>
    items.map((it) => (
      <RailBtn
        key={it.key}
        icon={<it.icon size={side ? SIDE_ICON_SIZE : 20} />}
        label={t(`nav.${it.key}`)}
        active={section === it.key}
        bottom={bottom}
        iconOnly={side}
        badge={badges[it.key] ?? 0}
        onClick={() => go(it.to)}
      />
    ));

  if (bottom) {
    const moreActive = BOTTOM_MORE.some((it) => it.key === section);
    const moreBadge = BOTTOM_MORE.reduce((sum, it) => sum + (badges[it.key] ?? 0), 0);
    return (
      <nav className={`glass flex items-center justify-around rounded-2xl px-1 py-1 ${className}`}>
        {buttons(BOTTOM_PRIMARY)}
        <MoreTab active={moreActive} badge={moreBadge} onSelect={go} />
      </nav>
    );
  }

  return (
    <nav
      className={`glass relative z-30 flex min-h-0 shrink-0 flex-col items-center overflow-hidden py-4 ${
        drawer ? "w-full rounded-none px-2" : "w-[72px] rounded-2xl px-3"
      } ${className}`}
    >
      <div
        className={`min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-color:var(--color-border)_transparent] [scrollbar-width:thin] ${
          // The 72px rail is 70px inside its glass border and only 46px inside
          // px-3 — less than one 48px button. So the side scroller bleeds out
          // across that padding (-mx-3, +1.5rem) to the full 70px, keeping just
          // px-1 of its own: 62px of content, 52px beside the thin scrollbar,
          // either way room for the 48px buttons and their glow. Do not add
          // w-full here — it overrides the calc width and brings back the
          // sideways overflow.
          side ? "-mx-3 flex w-[calc(100%+1.5rem)] flex-col items-center gap-1 px-1" : "w-full space-y-1"
        }`}
      >
        {buttons(ITEMS)}
      </div>
      {!drawer && (
        <div className="flex w-full shrink-0 justify-center pt-5">
          <ProfileMenu variant="rail" />
        </div>
      )}
    </nav>
  );
}

/** The bottom bar's overflow tab: opens a small anchored popup listing
 *  Members/Org/Settings. Renders in the active/purple state when the current
 *  section is one of those three, so "I'm in a More section" stays visible
 *  even though none of its items are pinned to the bar itself. */
function MoreTab({
  active,
  badge,
  onSelect,
}: {
  active: boolean;
  badge: number;
  onSelect: (to: string) => void;
}) {
  const { t } = useTranslation("shell");
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  const popupRef = usePopupDismiss<HTMLDivElement>(open, close, [panelRef]);

  return (
    <div ref={popupRef} className="relative flex-1">
      <RailBtn
        icon={<MoreHorizontal size={20} />}
        label={t("nav.more")}
        active={active}
        bottom
        badge={badge}
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <AnchoredPopover
          anchor={popupRef}
          panelRef={panelRef}
          preferred="above"
          gap={8}
          role="menu"
          className="glass w-44 overflow-y-auto rounded-2xl border border-border p-1 shadow-soft"
        >
          {BOTTOM_MORE.map((it) => (
            <button
              key={it.key}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onSelect(it.to);
              }}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm font-medium text-fg transition-colors hover:bg-surface-2"
            >
              <it.icon size={17} className="text-muted" />
              {t(`nav.${it.key}`)}
            </button>
          ))}
        </AnchoredPopover>
      )}
    </div>
  );
}

function RailBtn({
  icon,
  label,
  active,
  bottom,
  iconOnly = false,
  badge = 0,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  bottom: boolean;
  /** The desktop side rail: icon only. The label survives as the tooltip and
   *  the accessible name, so nothing about the control is lost to a screen
   *  reader or a hover. */
  iconOnly?: boolean;
  badge?: number;
  onClick: () => void;
}) {
  const { t } = useTranslation("shell");
  const title = badge > 0 ? t("railBtn.titleWithBadge", { label, count: badge }) : label;
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={iconOnly ? title : undefined}
      aria-current={active ? "page" : undefined}
      className={`relative flex flex-col items-center gap-1 rounded-xl transition-all active:scale-95 ${
        bottom ? "text-[11px] font-bold" : "text-sm font-semibold"
      } ${
        bottom
          ? "flex-1 py-1.5"
          : iconOnly
            ? "h-12 w-12 shrink-0 justify-center"
            : "w-full flex-row justify-start gap-3 px-3 py-3 text-left"
      } ${
        active
          ? "bg-gradient-to-br from-brand-from via-brand-mid to-brand-to text-accent-fg shadow-[0_6px_18px_-6px_var(--color-accent)] hover:brightness-105"
          : "text-muted hover:bg-surface-2 hover:text-fg"
      }`}
    >
      <span className="relative">
        {icon}
        {badge > 0 && (
          <span
            aria-label={t("railBtn.unreadAriaLabel", { count: badge })}
            className="pointer-events-none absolute -right-2 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[9px] font-semibold leading-none text-white shadow-[0_0_0_2px_var(--color-surface)]"
          >
            {badge > 99 ? "99+" : badge}
          </span>
        )}
      </span>
      {!iconOnly && label}
    </button>
  );
}
