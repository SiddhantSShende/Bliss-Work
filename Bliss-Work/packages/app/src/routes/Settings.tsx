/**
 * Settings page — preferences that aren't part of the user's public identity.
 *
 * Today this is small: theme + a couple of notification toggles + an "about"
 * footer that exposes the build version for support. As we add features
 * (notification cadence, language, time zone, default thread sort) they land
 * here — Profile.tsx stays focused on "how teammates see you".
 *
 * Notification preferences are stored client-side in localStorage for now;
 * when the backend gains a `user_settings` table they should move there so
 * they sync across devices.
 */
import { useEffect, useState } from "react";
import { Palette, MoreVertical, Check, Bell, BellOff, Info, RefreshCw, Eye, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button, PageHeader, useTheme, THEMES, themeClasses, themeName, type ThemeId } from "@taskboard/ui";
import { Link } from "react-router-dom";
import { DeviceActivitySettings } from "../features/DeviceActivitySettings";
import { BUILD_SHA } from "../lib/buildInfo";
import { useRuntime } from "../lib/runtime";
import { useGoBack } from "../lib/useGoBack";
import { usePopupDismiss } from "../lib/usePopupDismiss";

const NOTIF_KEY = "tb.notifications.desktop";

function loadDesktopNotifs(): boolean {
  try {
    return localStorage.getItem(NOTIF_KEY) !== "off";
  } catch {
    return true;
  }
}

function saveDesktopNotifs(on: boolean) {
  try {
    localStorage.setItem(NOTIF_KEY, on ? "on" : "off");
  } catch {
    /* localStorage may be unavailable in some Electron contexts */
  }
}

export function Settings() {
  const { theme } = useTheme();
  const goBack = useGoBack();
  const [desktopNotifs, setDesktopNotifs] = useState(loadDesktopNotifs);

  const toggleNotifs = () => {
    const next = !desktopNotifs;
    setDesktopNotifs(next);
    saveDesktopNotifs(next);
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Settings"
        subtitle="Preferences for how the app behaves on this device."
        onBack={goBack}
      />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-xl space-y-4">
          <SettingRow
            icon={<Palette size={18} />}
            title="Theme"
            description={`Currently using ${themeName(theme)}.`}
            action={<ThemeMenu />}
          />

          <SettingRow
            icon={<ShieldCheck size={18} />}
            title="Two-factor authentication"
            description="Add an authenticator app or a passkey as a second sign-in step."
            action={
              <Link to="/app/settings/security">
                <Button variant="subtle" size="sm">Manage</Button>
              </Link>
            }
          />

          {/* Permanently discoverable, unlike the dismissible banner: a member
              must always be able to find what is recorded about them. */}
          <SettingRow
            icon={<Eye size={18} />}
            title="Your activity"
            description="See everything BlissWork records about how you work — the same record your workspace admins see."
            action={
              <Link to="/app/settings/activity">
                <Button variant="subtle" size="sm">View</Button>
              </Link>
            }
          />

          {/* Desktop only — absent on web, where a browser cannot observe other
              applications at all. */}
          <DeviceActivitySettings />

          <SettingRow
            icon={desktopNotifs ? <Bell size={18} /> : <BellOff size={18} />}
            title="Desktop notifications"
            description={
              desktopNotifs
                ? "Show toasts when new messages and tasks arrive."
                : "Toasts are paused. You can still see notifications in the bell menu."
            }
            action={
              <Button variant="subtle" size="sm" onClick={toggleNotifs}>
                {desktopNotifs ? "Turn off" : "Turn on"}
              </Button>
            }
          />

          <AboutRow />
        </div>
      </div>
    </div>
  );
}

/** 3-dot menu next to "Theme": pick one of the app's named themes. Each row's
 *  swatch is a live miniature rendered with that theme's own CSS classes, so
 *  it reads straight off theme.css instead of a colour list duplicated here. */
function ThemeMenu() {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const wrap = usePopupDismiss<HTMLDivElement>(open, close);

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        title="Change theme"
        aria-label="Change theme"
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
      >
        <MoreVertical size={18} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Theme"
          className="absolute right-0 z-[1000] mt-1.5 w-72 rounded-xl border border-border bg-surface p-1.5 shadow-card"
        >
          {THEMES.map((opt) => (
            <button
              key={opt.id}
              type="button"
              role="menuitemradio"
              aria-checked={opt.id === theme}
              onClick={() => {
                setTheme(opt.id);
                close();
              }}
              className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-surface-2"
            >
              <ThemeSwatch themeId={opt.id} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{opt.name}</span>
              {opt.id === theme && <Check size={16} className="shrink-0 text-accent" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Miniature bg/sidebar/surface/accent preview for one theme, independent of
 *  whichever theme is currently active on <html> — it carries its own theme
 *  classes so the CSS variables it reads resolve to that theme's palette. */
function ThemeSwatch({ themeId }: { themeId: ThemeId }) {
  return (
    <span
      className={`flex h-9 w-14 shrink-0 overflow-hidden rounded-md border border-border ${themeClasses(themeId).join(" ")}`}
      style={{ background: "var(--color-bg)" }}
    >
      <span className="h-full w-3 shrink-0" style={{ background: "var(--color-surface-2)" }} />
      <span className="flex flex-1 items-end justify-end p-1" style={{ background: "var(--color-surface)" }}>
        <span className="h-2 w-2 rounded-full" style={{ background: "var(--color-accent)" }} />
      </span>
    </span>
  );
}

/**
 * About — which build is this, and is it current?
 *
 * Both halves earned their place. On desktop, an installed app can sit weeks
 * behind the web app with nothing on screen to say so; that is precisely how
 * "the desktop app is missing features" happens, and neither the user nor
 * support could previously tell which build was running. On web, the deployed
 * commit distinguishes "the fix isn't live" from "my browser cached the old
 * bundle" — which look identical otherwise.
 */
function AboutRow() {
  const { config } = useRuntime();
  const [version, setVersion] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!config.appVersion) return;
    let alive = true;
    config
      .appVersion()
      .then((v) => alive && setVersion(v))
      // A missing version is cosmetic — never let it break the page.
      .catch(() => alive && setVersion(null));
    return () => {
      alive = false;
    };
  }, [config]);

  const check = async () => {
    if (!config.checkForUpdates) return;
    setChecking(true);
    try {
      const r = await config.checkForUpdates();
      if (r.status === "downloading" || r.status === "available") {
        toast.success(`Update to ${r.version} is downloading`, {
          description: "You'll be asked to restart when it's ready.",
        });
      } else if (r.status === "up-to-date") {
        toast.success("You're up to date", { description: `Version ${r.version}` });
      } else {
        // 'unsupported' (dev run / Store build) and 'error' both carry a
        // specific message — show it rather than a generic failure.
        toast(r.message ?? "Couldn't check for updates");
      }
    } finally {
      setChecking(false);
    }
  };

  const description = version
    ? `BlissWork ${version} · desktop`
    : `BlissWork · build ${BUILD_SHA}`;

  return (
    <SettingRow
      icon={<Info size={18} />}
      title="About"
      description={description}
      action={
        config.checkForUpdates ? (
          <Button variant="subtle" size="sm" onClick={check} disabled={checking}>
            <RefreshCw size={14} className={checking ? "animate-spin" : undefined} />
            {checking ? "Checking…" : "Check for updates"}
          </Button>
        ) : null
      }
    />
  );
}

function SettingRow({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action: React.ReactNode;
}) {
  return (
    <div className="glass flex items-center gap-4 rounded-2xl p-4">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-fg">{title}</div>
        <div className="mt-0.5 text-xs text-muted">{description}</div>
      </div>
      {action}
    </div>
  );
}
