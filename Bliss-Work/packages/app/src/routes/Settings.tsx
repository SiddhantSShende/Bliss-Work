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
import { Palette, MoreVertical, Check, Bell, BellOff, Info, RefreshCw, Eye, ShieldCheck, MonitorSmartphone, Sun, Moon } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Button, PageHeader, useTheme, THEMES, themeClasses, themeName, darkCounterpart, type ThemeId } from "@taskboard/ui";
import { Link } from "react-router-dom";
import { BUILD_SHA } from "../lib/buildInfo";
import { useRuntime } from "../lib/runtime";
import { useGoBack } from "../lib/useGoBack";
import { usePopupDismiss } from "../lib/usePopupDismiss";
import { loadDesktopNotifs, saveDesktopNotifs } from "../lib/notificationPrefs";

export function Settings() {
  const { t } = useTranslation(["settings", "common"]);
  const { theme } = useTheme();
  const { config } = useRuntime();
  const goBack = useGoBack();
  const [desktopNotifs, setDesktopNotifs] = useState(loadDesktopNotifs);

  // The Electron main process raises OS popups for messages/tasks/calls on its
  // own (apps/desktop/src/main/notifier.ts) and has no access to this
  // renderer's localStorage, so the preference is mirrored to it explicitly:
  // once on mount, to cover a value set before this bridge existed, and again
  // on every toggle below.
  useEffect(() => {
    void config.notificationPrefs?.setDesktopEnabled(desktopNotifs);
    // Mount-time sync only — toggleNotifs below handles every later change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleNotifs = () => {
    const next = !desktopNotifs;
    setDesktopNotifs(next);
    saveDesktopNotifs(next);
    void config.notificationPrefs?.setDesktopEnabled(next);
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t("settings:header.title")}
        subtitle={t("settings:header.subtitle")}
        onBack={goBack}
      />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-xl space-y-4">
          <SettingRow
            icon={<Palette size={18} />}
            title={t("settings:theme.title")}
            description={t("settings:theme.description", { theme: themeName(theme) })}
            action={<ThemeMenu />}
          />

          <SettingRow
            icon={<ShieldCheck size={18} />}
            title={t("settings:twoFactor.title")}
            description={t("settings:twoFactor.description")}
            action={
              <Link to="/app/settings/security">
                <Button variant="subtle" size="sm">{t("common:buttons.manage")}</Button>
              </Link>
            }
          />

          <SettingRow
            icon={<MonitorSmartphone size={18} />}
            title={t("settings:activeSessions.title")}
            description={t("settings:activeSessions.description")}
            action={
              <Link to="/app/settings/sessions">
                <Button variant="subtle" size="sm">{t("common:buttons.view")}</Button>
              </Link>
            }
          />

          {/* Permanently discoverable, unlike the dismissible banner: a member
              must always be able to find what is recorded about them. */}
          <SettingRow
            icon={<Eye size={18} />}
            title={t("settings:activity.title")}
            description={t("settings:activity.description", { brand: "BlissWork" })}
            action={
              <Link to="/app/settings/activity">
                <Button variant="subtle" size="sm">{t("common:buttons.view")}</Button>
              </Link>
            }
          />

          <SettingRow
            icon={desktopNotifs ? <Bell size={18} /> : <BellOff size={18} />}
            title={t("settings:desktopNotifications.title")}
            description={
              desktopNotifs
                ? t("settings:desktopNotifications.onDescription")
                : t("settings:desktopNotifications.offDescription")
            }
            action={
              <Button variant="subtle" size="sm" onClick={toggleNotifs}>
                {desktopNotifs ? t("settings:desktopNotifications.turnOff") : t("settings:desktopNotifications.turnOn")}
              </Button>
            }
          />

          <AboutRow />
        </div>
      </div>
    </div>
  );
}

/** 3-dot menu next to "Theme": pick Light/Dark appearance and one of the
 *  app's six named accent themes. Each row's swatch is a live miniature
 *  rendered with that theme's own CSS classes, so it reads straight off
 *  theme.css instead of a colour list duplicated here. */
function ThemeMenu() {
  const { t } = useTranslation("settings");
  const { theme, isDark, toggle, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const wrap = usePopupDismiss<HTMLDivElement>(open, close);
  // THEMES only lists each family's light id (see themes.ts), so comparing
  // `theme` straight against `opt.id` would leave every row unchecked while
  // in Dark mode. Reduce `theme` to its light-mode id first — the family the
  // active theme belongs to, independent of which mode it's currently in.
  const activeFamily = isDark ? darkCounterpart(theme) : theme;

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        title={t("settings:theme.changeTheme")}
        aria-label={t("settings:theme.changeTheme")}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
      >
        <MoreVertical size={18} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t("settings:theme.menuLabel")}
          className="absolute right-0 z-[1000] mt-1.5 w-72 rounded-xl border border-border bg-surface p-1.5 shadow-card"
        >
          <div className="flex gap-1 p-1">
            <AppearanceOption icon={<Sun size={14} />} label={t("settings:theme.light")} active={!isDark} onClick={() => isDark && toggle()} />
            <AppearanceOption icon={<Moon size={14} />} label={t("settings:theme.dark")} active={isDark} onClick={() => !isDark && toggle()} />
          </div>
          <div className="my-1 h-px bg-border/60" />
          {THEMES.map((opt) => (
            <button
              key={opt.id}
              type="button"
              role="menuitemradio"
              aria-checked={opt.id === activeFamily}
              onClick={() => {
                // Preserve the current Light/Dark choice — picking an accent
                // here must not silently flip appearance back to Light.
                setTheme(isDark ? darkCounterpart(opt.id) : opt.id);
                close();
              }}
              className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-surface-2"
            >
              <ThemeSwatch themeId={opt.id} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{opt.name}</span>
              {opt.id === activeFamily && <Check size={16} className="shrink-0 text-accent" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Light/Dark segmented control — reuses ThemeProvider's own `toggle` (same
 *  one Profile → Dark Mode calls) rather than a second appearance concept, so
 *  the two entry points can never disagree about what "dark" means. */
function AppearanceOption({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-medium transition-colors ${
        active ? "bg-accent text-accent-fg" : "text-muted hover:bg-surface-2 hover:text-fg"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

/** Miniature bg/sidebar/surface/accent preview for one theme, independent of
 *  whichever theme is currently active on <html> — it carries its own theme
 *  classes so the CSS variables it reads resolve to that theme's palette.
 *  The accent swatch is the family's brand-from→brand-to gradient rather
 *  than a flat dot, so a blended family like Blue + Purple reads correctly
 *  as a mix rather than a single flat colour. */
function ThemeSwatch({ themeId }: { themeId: ThemeId }) {
  return (
    <span
      className={`flex h-9 w-14 shrink-0 overflow-hidden rounded-md border border-border ${themeClasses(themeId).join(" ")}`}
      style={{ background: "var(--color-bg)" }}
    >
      <span className="h-full w-3 shrink-0" style={{ background: "var(--color-surface-2)" }} />
      <span className="flex flex-1 items-end justify-end p-1" style={{ background: "var(--color-surface)" }}>
        <span
          className="h-2 w-2 rounded-full"
          style={{ background: "linear-gradient(135deg, var(--color-brand-from), var(--color-brand-to))" }}
        />
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
  const { t } = useTranslation("settings");
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

  // The "downloading" toast below promises a restart prompt "when it's
  // ready" — that promise already resolved by the time a background download
  // failure could happen, so this is the only way that failure still reaches
  // the user instead of the download looking silently stuck forever.
  useEffect(() => {
    if (!config.onUpdateCheckFailed) return;
    return config.onUpdateCheckFailed((message) => {
      toast.error(t("settings:about.toasts.updateDownloadFailed"), { description: message });
    });
  }, [config, t]);

  const check = async () => {
    if (!config.checkForUpdates) return;
    setChecking(true);
    try {
      const r = await config.checkForUpdates();
      if (r.status === "downloading" || r.status === "available") {
        toast.success(t("settings:about.toasts.updateDownloading", { version: r.version }), {
          description: t("settings:about.toasts.updateDownloadingDescription"),
        });
      } else if (r.status === "up-to-date") {
        toast.success(t("settings:about.toasts.upToDate"), {
          description: t("settings:about.toasts.upToDateDescription", { version: r.version }),
        });
      } else {
        // 'unsupported' (dev run / Store build) and 'error' both carry a
        // specific message — show it rather than a generic failure.
        toast(r.message ?? t("settings:about.toasts.checkFailedFallback"));
      }
    } finally {
      setChecking(false);
    }
  };

  const description = version
    ? t("settings:about.versionDesktop", { brand: "BlissWork", version })
    : t("settings:about.versionBuild", { brand: "BlissWork", sha: BUILD_SHA });

  return (
    <SettingRow
      icon={<Info size={18} />}
      title={t("settings:about.title")}
      description={description}
      action={
        config.checkForUpdates ? (
          <Button variant="subtle" size="sm" onClick={check} disabled={checking}>
            <RefreshCw size={14} className={checking ? "animate-spin" : undefined} />
            {checking ? t("settings:about.checking") : t("settings:about.checkForUpdates")}
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
