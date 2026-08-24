import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { User, LogOut, Sun, Moon, Settings, ChevronDown } from "lucide-react";
import { Avatar, useTheme } from "@taskboard/ui";
import { useSession } from "../store/session";
import { useRuntime } from "../lib/runtime";
import { signOut } from "../lib/signOut";

/** Avatar-anchored account popover in the top navbar. */
export function ProfileMenu({ variant = "navbar" }: { variant?: "navbar" | "rail" }) {
  const { api, config, ws } = useRuntime();
  const user = useSession((s) => s.user)!;
  const { theme, toggle } = useTheme();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const go = (to: string) => {
    setOpen(false);
    nav(to);
  };
  const openProfile = () => {
    if (variant === "rail") {
      nav(`/app/members/${user.id}`);
      return;
    }
    setOpen((v) => !v);
  };
  // The order matters and lives in signOut(): the activity session and the
  // socket are both closed BEFORE the token is cleared, or the person keeps
  // reading as Online to their colleagues after signing out.
  const logout = async () => {
    await signOut(api, config, ws);
    nav("/login");
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={openProfile}
        title={`${user.displayName} — account menu`}
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        className={
          variant === "rail"
            ? "relative flex w-full items-center gap-2 rounded-xl px-1.5 py-2 text-left transition hover:bg-surface-2"
            : "flex items-center gap-1 rounded-full pl-0.5 pr-1.5 py-0.5 ring-2 ring-transparent transition hover:bg-surface-2/80 hover:ring-accent/40"
        }
      >
        <Avatar name={user.displayName} size={variant === "rail" ? "sm" : "md"} />
        {variant === "rail" ? (
          <>
            <span className="min-w-0 flex-1 pr-3">
              <span className="block truncate text-xs font-semibold text-fg">{user.displayName}</span>
              <span className="flex items-center gap-1 text-[10px] text-muted">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" /> Online
              </span>
            </span>
          </>
        ) : (
          <ChevronDown size={14} className="text-muted transition-transform" style={{ transform: open ? "rotate(180deg)" : "none" }} />
        )}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, scale: 0.96, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -6 }}
            transition={{ type: "spring", stiffness: 360, damping: 30 }}
            className={`${variant === "rail" ? "fixed bottom-4 left-[156px]" : "absolute right-0 top-12"} z-[100] w-60 overflow-hidden rounded-2xl border border-border bg-surface/95 p-1.5 shadow-card`}
          >
            <div className="flex items-center gap-3 px-2.5 py-2.5">
              <Avatar name={user.displayName} />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-fg">{user.displayName}</div>
                <div className="truncate text-xs text-muted">{user.email}</div>
              </div>
            </div>
            <div className="my-1 h-px bg-border/60" />
            <MenuItem icon={<User size={16} />} label="Edit profile" onClick={() => go("/app/profile")} />
            <MenuItem icon={<Settings size={16} />} label="Settings" onClick={() => go("/app/settings")} />
            <MenuItem
              icon={theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
              label={theme === "dark" ? "Light mode" : "Dark mode"}
              onClick={toggle}
            />
            <div className="my-1 h-px bg-border/60" />
            <MenuItem icon={<LogOut size={16} />} label="Sign out" onClick={logout} danger />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm font-medium transition-colors hover:bg-surface-2 ${
        danger ? "text-danger" : "text-fg"
      }`}
    >
      <span className={danger ? "text-danger" : "text-muted"}>{icon}</span>
      {label}
    </button>
  );
}
