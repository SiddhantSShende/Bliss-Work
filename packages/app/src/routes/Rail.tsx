import { useNavigate } from "react-router-dom";
import { Inbox, MessageSquare, ListTodo, Hash, Users, Plug, Building2 } from "lucide-react";
import { useSession } from "../store/session";

const ITEMS = [
  { key: "inbox", label: "Inbox", icon: Inbox, to: "/app/inbox" },
  { key: "chats", label: "Chats", icon: MessageSquare, to: "/app/chats" },
  { key: "tasks", label: "Tasks", icon: ListTodo, to: "/app/tasks/allocated" },
  { key: "channels", label: "Channels", icon: Hash, to: "/app/channels" },
  { key: "members", label: "Members", icon: Users, to: "/app/members" },
  { key: "org", label: "Org", icon: Building2, to: "/app/org" },
  // Enterprise-only: External Integrations + forward-tracking. Hidden for other
  // plans (the server also enforces the gate — this is just UX).
  { key: "integrations", label: "Integrations", icon: Plug, to: "/app/integrations", requiresEnterprise: true },
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
  /** Per-section unread/alert counts keyed by item.key (e.g. inbox, tasks). A
   *  value > 0 renders a red badge on top of that icon. */
  badges?: Record<string, number>;
}) {
  const nav = useNavigate();
  const bottom = variant === "bottom";
  const isEnterprise = useSession((s) => s.user?.plan === "enterprise");
  const items = ITEMS.filter((it) => !("requiresEnterprise" in it && it.requiresEnterprise) || isEnterprise);
  return (
    <nav
      className={`glass rounded-2xl ${
        bottom
          ? "flex items-center justify-around px-1 py-1"
          : "flex w-[84px] shrink-0 flex-col items-center gap-2 py-4"
      } ${className}`}
    >
      {items.map((it) => (
        <RailBtn
          key={it.key}
          icon={<it.icon size={20} />}
          label={it.label}
          active={section === it.key}
          bottom={bottom}
          badge={badges[it.key] ?? 0}
          onClick={() => nav(it.to)}
        />
      ))}
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
      className={`relative flex flex-col items-center gap-1 rounded-xl text-[11px] font-medium transition-all active:scale-95 ${
        bottom ? "flex-1 py-1.5" : "w-16 py-2.5"
      } ${
        active
          ? "bg-gradient-to-br from-brand-from to-brand-to text-accent-fg shadow-[0_6px_18px_-6px_var(--color-accent)]"
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
