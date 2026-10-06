import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Menu, Search, UserPlus, Bell, X } from "lucide-react";
import { Button, IconButton, Wordmark } from "@taskboard/ui";
import { ProfileMenu } from "./ProfileMenu";
import { GetAppButton } from "./GetAppButton";
import { OrgSwitcher } from "./OrgSwitcher";
import { LanguageSwitcher } from "../i18n/LanguageSwitcher";
import { unreadBadgeLabel } from "../lib/unreadNotificationCount";
import { useRuntime } from "../lib/runtime";
import { useTitleBarTheme } from "../lib/useTitleBarTheme";

// Room the desktop app reserves for the native window controls. They occupy the
// part of the window that titlebar-area-* does NOT cover (right on Windows/Linux);
// macOS's traffic lights sit at the left and are not reported that way.
const CONTROLS_INSET_RIGHT = "max(0.75rem, calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw)))";
const CONTROLS_INSET_LEFT = "5.5rem";
const BAR_PAD = "0.75rem";
// What the desktop search bar must leave clear on each side of the window centre:
// logo + a shrunken org switcher on the left, the notification/language/profile
// cluster on the right.
const LEFT_GROUP_MIN = "12rem";
const RIGHT_GROUP_MIN = "11rem";

/**
 * Global top navbar: brand · search · invite · notifications · account.
 *
 * In the desktop app (`config.windowControls`) this is the window's ONLY header:
 * the OS title bar is hidden and the native min/max/close controls are drawn
 * over the bar's right edge. It becomes a flat, full-width, draggable bar —
 * brand · org · search · notifications · language · account — with no Invite
 * button; the interactive parts opt out of dragging with `app-no-drag`. The
 * search bar is centred on the WINDOW (not between the two clusters), so it sits
 * out of flow, `left-1/2` of the full-width bar, and its width is capped so it
 * never runs under either cluster. The brand is the wordmark alone (no icon).
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
  const { config } = useRuntime();
  const controls = config.windowControls;
  const barRef = useRef<HTMLElement | null>(null);
  const [q, setQ] = useState("");
  const badge = unreadBadgeLabel(unread);

  useTitleBarTheme(barRef);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    if (term) nav(`/app/search?q=${encodeURIComponent(term)}`);
  };

  const padLeft = controls?.side === "left" ? CONTROLS_INSET_LEFT : BAR_PAD;
  const padRight = controls && controls.side !== "left" ? CONTROLS_INSET_RIGHT : BAR_PAD;
  const barStyle = controls
    ? ({
        paddingLeft: padLeft,
        paddingRight: padRight,
        "--bw-pad-l": padLeft,
        "--bw-search-w": `min(28rem, calc(100vw - 2 * max(${padLeft} + ${LEFT_GROUP_MIN}, ${padRight} + ${RIGHT_GROUP_MIN})))`,
      } as React.CSSProperties)
    : undefined;
  const noDrag = controls ? "app-no-drag" : "";

  return (
    <header
      ref={barRef}
      style={barStyle}
      className={
        controls
          ? "app-drag app-titlebar relative z-50 order-first flex h-12 shrink-0 items-center gap-3 max-md:gap-1.5 border-b border-border bg-surface px-3 text-fg"
          : "glass relative z-50 mx-2 mb-0 mt-[max(0.5rem,env(safe-area-inset-top))] flex h-14 shrink-0 items-center gap-3 rounded-2xl px-3"
      }
    >
      {/* `contents` everywhere but the desktop app at md+, where the left group
          gets its own box so its width can be capped to stay clear of the
          window-centred search bar. */}
      <div
        className={
          controls
            ? "contents md:flex md:min-w-0 md:max-w-[calc(50vw-var(--bw-search-w)/2-var(--bw-pad-l)-0.75rem)] md:items-center md:gap-3"
            : "contents"
        }
      >
        <IconButton onClick={onOpenDrawer} title={t("topNavbar.openMenu")} aria-label={t("topNavbar.openNavigationMenu")} className={`md:hidden ${noDrag}`}>
          <Menu size={20} />
        </IconButton>

        <button
          onClick={() => nav("/app/mail")}
          title="BlissWork"
          className={`shrink-0 rounded-xl px-1 transition hover:opacity-80 ${noDrag}`}
        >
          {/* 17px → 22px. A narrow desktop window (minus up to 138px of native
              controls on Windows) only has room for the old size, so it steps
              back down below 540px. */}
          <Wordmark showIcon={false} textClassName={controls ? "text-[22px] max-[540px]:text-[17px]" : "text-[22px]"} />
        </button>

        {/* md:contents unwraps this on desktop/tablet, so OrgSwitcher sits
            exactly where it always has, right after the logo. Below md the
            wrapper takes over the middle of the header (search hides there
            instead — see the form below) and centers it, matching the mobile
            header's left/CENTER/right layout. */}
        <div className={`flex flex-1 justify-center md:contents ${controls ? "min-w-0" : ""}`}>
          {/* Desktop: the org name truncates to make room for the native controls,
              and below 560px gives way to its icon. */}
          <div className={controls ? `${noDrag} min-w-0 [&>div>button]:max-w-full max-[560px]:[&_span.truncate]:hidden` : undefined}>
            <OrgSwitcher />
          </div>
        </div>
      </div>

      <form
        onSubmit={submit}
        className={
          controls
            ? "absolute left-1/2 top-1/2 hidden w-[var(--bw-search-w)] -translate-x-1/2 -translate-y-1/2 md:flex"
            : "hidden flex-1 justify-center px-2 md:flex"
        }
      >
        <div className={`relative w-full max-w-md ${noDrag}`}>
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

      <div className={`flex shrink-0 items-center gap-1.5 ${controls ? "ml-auto" : ""} ${noDrag}`}>
        {/* Desktop-app download (web only; renders nothing in the Electron build). */}
        <GetAppButton mode="compact" className="hidden md:block" />
        {/* Not offered in the desktop app. */}
        {!controls && (
          <Button
            variant="subtle"
            size="sm"
            onClick={() => nav("/app/invite")}
            className="hidden md:inline-flex"
          >
            <UserPlus size={15} /> {t("topNavbar.invite")}
          </Button>
        )}
        {/* Search moves here below md, in place of the hidden inline form
            above — the mobile header has no room for a full search bar. */}
        <IconButton onClick={() => nav("/app/search")} title={t("topNavbar.search")} className="md:hidden">
          <Search size={18} />
        </IconButton>
        <div className="relative">
          <IconButton onClick={onOpenNotifs} title={t("topNavbar.notifications")}>
            <Bell size={18} />
          </IconButton>
          {badge && (
            <span className="pointer-events-none absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[9px] font-semibold text-white">
              {badge}
            </span>
          )}
        </div>
        <LanguageSwitcher />
        <ProfileMenu />
      </div>
    </header>
  );
}
