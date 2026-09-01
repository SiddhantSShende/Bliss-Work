import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Logo, isThemeId, themeClasses, defaultThemeFor, ALL_THEME_CLASSES } from "@taskboard/ui";
import { Phone, Video, X } from "lucide-react";
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
    };
    apply();
    window.addEventListener("storage", apply);
    return () => window.removeEventListener("storage", apply);
  }, []);
}

function MeetingInviteApp() {
  useSyncedTheme();
  const bridge = window.meetingInvite;
  const [invite, setInvite] = useState<Invite>({
    callId: bridge.callId,
    title: bridge.title,
    organizer: bridge.organizer,
  });

  useEffect(() => bridge.onUpdate(setInvite), [bridge]);

  return (
    <div className="app-drag flex h-full flex-col items-center justify-center gap-3 bg-surface p-4 text-center">
      <Logo size={30} />
      <div className="line-clamp-2 text-sm font-semibold text-fg">{invite.title || "Meeting"}</div>
      {invite.organizer && <div className="text-xs text-muted">Hosted by {invite.organizer}</div>}
      <div className="app-no-drag mt-1 flex items-center justify-center gap-5">
        <InviteAction
          icon={<Video size={18} />}
          label="Video"
          title="Join with camera on"
          tone="accent"
          onClick={() => bridge.act("video")}
        />
        <InviteAction
          icon={<Phone size={18} />}
          label="Voice"
          title="Join with voice only"
          tone="accent"
          onClick={() => bridge.act("voice")}
        />
        <InviteAction
          icon={<X size={18} />}
          label="Leave"
          title="Dismiss"
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

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MeetingInviteApp />
  </React.StrictMode>,
);
