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
import { useState } from "react";
import { Sun, Moon, Bell, BellOff, Info } from "lucide-react";
import { Button, PageHeader } from "@taskboard/ui";
import { useTheme } from "@taskboard/ui";

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
  const [desktopNotifs, setDesktopNotifs] = useState(loadDesktopNotifs);

  const toggleNotifs = () => {
    const next = !desktopNotifs;
    setDesktopNotifs(next);
    saveDesktopNotifs(next);
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Settings" subtitle="Preferences for how the app behaves on this device." />
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

          <SettingRow
            icon={<Info size={18} />}
            title="About"
            description="Task-Board"
            action={null}
          />
        </div>
      </div>
    </div>
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
