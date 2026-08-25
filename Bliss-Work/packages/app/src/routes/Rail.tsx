import { useNavigate } from "react-router-dom";
import { Mail, Calendar, MessageSquare, ListTodo, Hash, Users, Plug, Building2, Settings } from "lucide-react";
import { ProfileMenu } from "../features/ProfileMenu";

const ITEMS = [
  { key: "mail", label: "Mail", icon: Mail, to: "/app/mail" },
  { key: "meetings", label: "Meetings", icon: Calendar, to: "/app/meetings" },
  { key: "chats", label: "Chats", icon: MessageSquare, to: "/app/chats" },
  { key: "tasks", label: "Tasks", icon: ListTodo, to: "/app/tasks/allocated" },
  { key: "channels", label: "Channels", icon: Hash, to: "/app/channels" },
  { key: "members", label: "Members", icon: Users, to: "/app/members" },
  { key: "org", label: "Org", icon: Building2, to: "/app/org" },
  // External Integrations + forward-tracking. Available to every org (each org
  // supplies its own third-party credentials) — not a Bliss-Work paid tier.
  { key: "integrations", label: "Integrations", icon: Plug, to: "/app/integrations" },
  { key: "settings", label: "Settings", icon: Settings, to: "/app/settings" },
] as const;

/**
 * Section navigation. `side` is the vertical rail used on tablet/desktop;
 * `bottom` is the horizontal tab bar used on phones (rendered at the bottom of
 * the shell so it sits under the thumb).
 */
export function Rail({
  section,
  variant = "side",
  className = "",
  badges = {},
}: {
  section: string | null;
  variant?: "side" | "bottom";
  className?: string;
  /** Per-section unread/alert counts keyed by item.key (e.g. mail, tasks). A
   *  value > 0 renders a red badge on top of that icon. */
  badges?: Record<string, number>;
}) {
  const nav = useNavigate();
  const bottom = variant === "bottom";
  const items = ITEMS;
  const buttons = items.map((it) => (
    <RailBtn
      key={it.key}
      icon={<it.icon size={20} />}
      label={it.label}
      active={section === it.key}
      bottom={bottom}
      badge={badges[it.key] ?? 0}
      onClick={() => nav(it.to)}
    />
  ));
  return (
    <nav
      className={`glass rounded-2xl ${
        bottom
          ? "flex items-center justify-around px-1 py-1"
          : "relative z-30 flex min-h-0 w-[140px] shrink-0 flex-col items-center overflow-hidden px-2 py-4"
      } ${className}`}
    >
      {bottom ? (
        buttons
      ) : (
        <>
          <div className="min-h-0 w-full flex-1 space-y-1 overflow-y-auto overscroll-contain [scrollbar-color:var(--color-border)_transparent] [scrollbar-width:thin]">
            {buttons}
          </div>
          <div className="w-full shrink-0 pt-5">
            <ProfileMenu variant="rail" />
          </div>
        </>
      )}
    </nav>
  );
}

function RailBtn({
  icon,
  label,
  active,
  bottom,
  badge = 0,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  bottom: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={badge > 0 ? `${label} (${badge} new)` : label}
      className={`relative flex flex-col items-center gap-1 rounded-xl transition-all active:scale-95 ${
        bottom ? "text-[11px] font-bold" : "text-sm font-semibold"
      } ${
        bottom ? "flex-1 py-1.5" : "w-full flex-row justify-start gap-3 px-3 py-3 text-left"
      } ${
        active
          ? "bg-gradient-to-br from-brand-from to-brand-to text-accent-fg shadow-[0_6px_18px_-6px_var(--color-accent)] hover:brightness-105"
          : "text-muted hover:bg-surface-2 hover:text-fg"
      }`}
    >
      <span className="relative">
        {icon}
        {badge > 0 && (
          <span
            aria-label={`${badge} unread`}
            className="pointer-events-none absolute -right-2 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[9px] font-semibold leading-none text-white shadow-[0_0_0_2px_var(--color-surface)]"
          >
            {badge > 99 ? "99+" : badge}
          </span>
        )}
      </span>
      {label}
    </button>
  );
}
