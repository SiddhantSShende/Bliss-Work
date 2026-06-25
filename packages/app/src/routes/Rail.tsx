import { useNavigate } from "react-router-dom";
import { Inbox, MessageSquare, ListTodo, Hash, Users } from "lucide-react";

const ITEMS = [
  { key: "inbox", label: "Inbox", icon: Inbox, to: "/app/inbox" },
  { key: "chats", label: "Chats", icon: MessageSquare, to: "/app/chats" },
  { key: "tasks", label: "Tasks", icon: ListTodo, to: "/app/tasks/allocated" },
  { key: "channels", label: "Channels", icon: Hash, to: "/app/channels" },
  { key: "members", label: "Members", icon: Users, to: "/app/members" },
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
}: {
  section: string | null;
  variant?: "side" | "bottom";
  className?: string;
}) {
  const nav = useNavigate();
  const bottom = variant === "bottom";
  return (
    <nav
      className={`glass rounded-2xl ${
        bottom
          ? "flex items-center justify-around px-1 py-1"
          : "flex w-[84px] shrink-0 flex-col items-center gap-2 py-4"
      } ${className}`}
    >
      {ITEMS.map((it) => (
        <RailBtn
          key={it.key}
          icon={<it.icon size={20} />}
          label={it.label}
          active={section === it.key}
          bottom={bottom}
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
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  bottom: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`flex flex-col items-center gap-1 rounded-xl text-[11px] font-medium transition-all active:scale-95 ${
        bottom ? "flex-1 py-1.5" : "w-16 py-2.5"
      } ${
        active
          ? "bg-gradient-to-br from-brand-from to-brand-to text-accent-fg shadow-[0_6px_18px_-6px_var(--color-accent)]"
          : "text-muted hover:bg-surface-2 hover:text-fg"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
