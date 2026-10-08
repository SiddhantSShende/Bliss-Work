import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CUSTOM_THEME_CLASS, customThemeStyle, isCustomThemeActive, isThemeId, readStoredCustomTheme, Logo, themeClasses, defaultThemeFor, ALL_THEME_CLASSES } from "@taskboard/ui";
import { Phone, Video, X } from "lucide-react";
import { followStoredLocale, useTranslation } from "@taskboard/app/i18n/windowLocale";
import "@taskboard/ui/styles.css";
import "./index.css";

interface Invite {
  callId: string;
  title: string;
  organizer: string;
}

declare global {
  interface Window {
    meetingInvite: {
      callId: string;
      title: string;
      organizer: string;
      onUpdate: (cb: (invite: Invite) => void) => () => void;
      ready: () => void;
      act: (action: "video" | "voice" | "leave") => void;
    };
  }
}

/** Same theme-sync approach as sticky.tsx's useSyncedTheme — see that file's
 *  own comment for why a `storage` listener is enough (same-origin
 *  BrowserWindows share localStorage in Electron, no IPC needed). This
 *  window is opaque with no cutout to color-match, so unlike the sticky note
 *  it never needs to report a resolved background back to main. */
function useSyncedTheme(): void {
  useEffect(() => {
    const apply = () => {
      const stored = localStorage.getItem("tb-theme");
      const classes = themeClasses(stored && isThemeId(stored) ? stored : defaultThemeFor(false));
      const root = document.documentElement;
      root.classList.remove(...ALL_THEME_CLASSES);
      root.classList.add(...classes);
      root.classList.remove(CUSTOM_THEME_CLASS);
      for (const property of ["--color-accent", "--color-accent-strong", "--color-accent-fg", "--color-accent-soft", "--color-brand-from", "--color-brand-mid", "--color-brand-to", "--color-brand-gradient"]) {
        root.style.removeProperty(property);
      }
      const custom = readStoredCustomTheme();
      if (custom && isCustomThemeActive()) {
        root.classList.add(CUSTOM_THEME_CLASS);
        for (const [property, value] of Object.entries(customThemeStyle(custom))) root.style.setProperty(property, value);
      }
    };
    apply();
    window.addEventListener("storage", apply);
    return () => window.removeEventListener("storage", apply);
  }, []);
}

function MeetingInviteApp() {
  useSyncedTheme();
  const { t } = useTranslation("stickies");
  useEffect(() => {
    document.title = t("window.titles.invite");
  }, [t]);
  const bridge = window.meetingInvite;
  const [invite, setInvite] = useState<Invite>({
    callId: bridge.callId,
    title: bridge.title,
    organizer: bridge.organizer,
  });

  useEffect(() => {
    const off = bridge.onUpdate(setInvite);
    // Signal readiness ONLY after the listener above is registered, so main
    // re-pushes the latest invite even if an update (e.g. the organizer
    // resolving) already arrived and was dropped before this effect ran —
    // same race, same fix, as sticky.tsx's window.sticky.ready().
    bridge.ready();
    return off;
  }, [bridge]);

  return (
    <div className="app-drag flex h-full flex-col items-center justify-center gap-3 bg-surface p-4 text-center">
      <Logo size={30} />
      <div className="line-clamp-2 text-sm font-semibold text-fg">{invite.title || t("window.invite.meetingFallback")}</div>
      {invite.organizer && <div className="text-xs text-muted">{t("window.invite.hostedBy", { name: invite.organizer })}</div>}
      <div className="app-no-drag mt-1 flex items-center justify-center gap-5">
        <InviteAction
          icon={<Video size={18} />}
          label={t("window.invite.video")}
          title={t("window.invite.videoTitle")}
          tone="accent"
          onClick={() => bridge.act("video")}
        />
        <InviteAction
          icon={<Phone size={18} />}
          label={t("window.invite.voice")}
          title={t("window.invite.voiceTitle")}
          tone="accent"
          onClick={() => bridge.act("voice")}
        />
        <InviteAction
          icon={<X size={18} />}
          label={t("window.invite.leave")}
          title={t("window.invite.dismiss")}
          tone="danger"
          onClick={() => bridge.act("leave")}
        />
      </div>
    </div>
  );
}

function InviteAction({
  icon,
  label,
  title,
  tone,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  title: string;
  tone: "accent" | "danger";
  onClick: () => void;
}) {
  const tones = {
    accent: "bg-accent-soft text-accent hover:brightness-95",
    danger: "bg-danger/10 text-danger hover:bg-danger/20",
  };
  return (
    <button type="button" onClick={onClick} title={title} aria-label={title} className="flex flex-col items-center gap-1">
      <span className={`flex h-10 w-10 items-center justify-center rounded-full transition ${tones[tone]}`}>
        {icon}
      </span>
      <span className="text-[11px] font-medium text-muted">{label}</span>
    </button>
  );
}

void followStoredLocale();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MeetingInviteApp />
  </React.StrictMode>,
);
