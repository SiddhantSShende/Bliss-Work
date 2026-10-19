import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "framer-motion";
import { User, LogOut, Sun, Moon, Settings, ChevronDown } from "lucide-react";
import { Avatar, useTheme } from "@taskboard/ui";
import { useSession } from "../store/session";
import { useRuntime } from "../lib/runtime";
import { signOut } from "../lib/signOut";
import { usePopupDismiss } from "../lib/usePopupDismiss";
import { usePopoverPosition } from "../lib/usePopoverPosition";

/** Avatar-anchored account popover in the top navbar. */
export function ProfileMenu({ variant = "navbar" }: { variant?: "navbar" | "rail" }) {
  const { t } = useTranslation("shell");
  const { api, config, ws } = useRuntime();
  const user = useSession((s) => s.user)!;
  const { isDark, toggle } = useTheme();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  const ref = usePopupDismiss<HTMLDivElement>(open, close, [panelRef]);
  const style = usePopoverPosition({
    anchor: ref,
    panelRef,
    align: "end",
    gap: 12,
    active: open,
  });

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
        title={t("profileMenu.accountMenuTitle", { name: user.displayName })}
        aria-label={t("profileMenu.accountMenuAriaLabel")}
        aria-haspopup={variant === "rail" ? undefined : "menu"}
        aria-expanded={variant === "rail" ? undefined : open}
        className={
          variant === "rail"
            ? "relative flex h-12 w-12 items-center justify-center rounded-xl transition hover:bg-surface-2"
            : "flex items-center gap-1 rounded-full pl-0.5 pr-1.5 py-0.5 ring-2 ring-transparent transition hover:bg-surface-2/80 hover:ring-accent/40"
        }
      >
        {/* The icon-only rail has no room for the name/"Online" text; the
            account name is still the tooltip, and the dot keeps the status. */}
        <Avatar
          name={user.displayName}
          src={user.avatarUrl}
          size={variant === "rail" ? "sm" : "md"}
          online={variant === "rail" ? true : undefined}
        />
        {variant !== "rail" && (
          <ChevronDown size={14} className="text-muted transition-transform" style={{ transform: open ? "rotate(180deg)" : "none" }} />
        )}
      </button>
      {typeof document !== "undefined" &&
        createPortal(
          <AnimatePresence>
            {open && (
              <motion.div
                ref={panelRef}
                role="menu"
                initial={{ opacity: 0, scale: 0.96, y: -6 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: -6 }}
                transition={{ type: "spring", stiffness: 360, damping: 30 }}
                style={style}
                className="fixed z-[var(--z-dropdown)] w-60 overflow-y-auto rounded-2xl border border-border bg-surface/95 p-1.5 shadow-card"
              >
                <div className="flex items-center gap-3 px-2.5 py-2.5">
                  <Avatar name={user.displayName} src={user.avatarUrl} />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-fg">{user.displayName}</div>
                    <div className="truncate text-xs text-muted">{user.email}</div>
                  </div>
                </div>
                <div className="my-1 h-px bg-border/60" />
                <MenuItem icon={<User size={16} />} label={t("profileMenu.editProfile")} onClick={() => go("/app/profile")} />
                <MenuItem icon={<Settings size={16} />} label={t("profileMenu.settings")} onClick={() => go("/app/settings")} />
                <MenuItem
                  icon={isDark ? <Sun size={16} /> : <Moon size={16} />}
                  label={isDark ? t("profileMenu.lightMode") : t("profileMenu.darkMode")}
                  onClick={toggle}
                />
                <div className="my-1 h-px bg-border/60" />
                <MenuItem icon={<LogOut size={16} />} label={t("profileMenu.signOut")} onClick={logout} danger />
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
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
