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
import { Sun, Moon, Bell, BellOff, Info, RefreshCw, Eye } from "lucide-react";
import { toast } from "sonner";
import { Button, PageHeader } from "@taskboard/ui";
import { Link } from "react-router-dom";
import { DeviceActivitySettings } from "../features/DeviceActivitySettings";
import { useTheme } from "@taskboard/ui";
import { BUILD_SHA } from "../lib/buildInfo";
import { useRuntime } from "../lib/runtime";
import { useGoBack } from "../lib/useGoBack";

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
  const { theme, toggle } = useTheme();
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
            icon={theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            title="Appearance"
            description={`Currently in ${theme === "dark" ? "dark" : "light"} mode.`}
            action={
              <Button variant="subtle" size="sm" onClick={toggle}>
                Use {theme === "dark" ? "light" : "dark"} mode
              </Button>
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
