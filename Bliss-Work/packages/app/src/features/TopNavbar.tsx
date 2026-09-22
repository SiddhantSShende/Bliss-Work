import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Menu, Search, UserPlus, Bell, X } from "lucide-react";
import { Button, IconButton, Wordmark } from "@taskboard/ui";
import { ProfileMenu } from "./ProfileMenu";
import { GetAppButton } from "./GetAppButton";
import { OrgSwitcher } from "./OrgSwitcher";
import { LanguageSwitcher } from "../i18n/LanguageSwitcher";

/**
 * Global top navbar: brand · search · invite · notifications · account.
 *
 * Below `md` this becomes the compact mobile header instead: a hamburger
 * (opens MobileNavDrawer, via `onOpenDrawer`) replaces the inline search bar
 * — search itself doesn't disappear, it moves to a small icon button in the
 * right-hand cluster — and the org switcher centers itself. `md:` and up is
 * pixel-identical to before.
 */
export function TopNavbar({
  unread,
  onOpenNotifs,
  onOpenDrawer,
}: {
  unread: number;
  onOpenNotifs: () => void;
  onOpenDrawer: () => void;
}) {
  const { t } = useTranslation("appShell");
  const nav = useNavigate();
  const [q, setQ] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    if (term) nav(`/app/search?q=${encodeURIComponent(term)}`);
  };

  return (
    <header className="glass relative z-50 mx-2 mb-0 mt-[max(0.5rem,env(safe-area-inset-top))] flex h-14 shrink-0 items-center gap-3 rounded-2xl px-3">
      <IconButton onClick={onOpenDrawer} title={t("topNavbar.openMenu")} aria-label={t("topNavbar.openNavigationMenu")} className="md:hidden">
        <Menu size={20} />
      </IconButton>

      <button
        onClick={() => nav("/app/mail")}
        title="BlissWork"
        className="shrink-0 rounded-xl px-1 transition hover:opacity-80"
      >
        <Wordmark size={26} />
      </button>

      {/* md:contents unwraps this on desktop/tablet, so OrgSwitcher sits
          exactly where it always has, right after the logo. Below md the
          wrapper takes over the middle of the header (search hides there
          instead — see the form below) and centers it, matching the mobile
          header's left/CENTER/right layout. */}
      <div className="flex flex-1 justify-center md:contents">
        <OrgSwitcher />
      </div>

      <form onSubmit={submit} className="hidden flex-1 justify-center px-2 md:flex">
        <div className="relative w-full max-w-md">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("topNavbar.searchPlaceholder")}
            className={`h-9 w-full rounded-xl border border-border bg-surface/70 pl-9 text-sm text-fg placeholder:text-muted/70 transition-colors focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 ${q ? "pr-9" : "pr-3"}`}
          />
          {q && (
            <button
              type="button"
              onClick={() => {
                setQ("");
                nav("/app/mail");
              }}
              title={t("topNavbar.clearSearch")}
              aria-label={t("topNavbar.clearSearch")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </form>

      <div className="flex shrink-0 items-center gap-1.5">
        {/* Desktop-app download (web only; renders nothing in the Electron build). */}
        <GetAppButton mode="compact" className="hidden md:block" />
        <Button
          variant="subtle"
          size="sm"
          onClick={() => nav("/app/invite")}
          className="hidden md:inline-flex"
        >
          <UserPlus size={15} /> {t("topNavbar.invite")}
        </Button>
        {/* Search moves here below md, in place of the hidden inline form
            above — the mobile header has no room for a full search bar. */}
        <IconButton onClick={() => nav("/app/search")} title={t("topNavbar.search")} className="md:hidden">
          <Search size={18} />
        </IconButton>
        <div className="relative">
          <IconButton onClick={onOpenNotifs} title={t("topNavbar.notifications")}>
            <Bell size={18} />
          </IconButton>
          {unread > 0 && (
            <span className="pointer-events-none absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[9px] font-semibold text-white">
              {unread}
            </span>
          )}
        </div>
        <LanguageSwitcher />
        <ProfileMenu />
      </div>
    </header>
  );
}
