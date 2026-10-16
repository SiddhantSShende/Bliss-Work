import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { applyTheme, isCustomThemeActive, isThemeId, readStoredCustomTheme, Logo, defaultThemeFor } from "@taskboard/ui";
import { Phone, Video, X } from "lucide-react";
import { followStoredLocale, useTranslation } from "@taskboard/app/i18n/windowLocale";
import "@taskboard/ui/styles.css";
import "./index.css";

interface Invite {
  callId: string;
  title: string;
  organizer: string;
  /** An ad-hoc call (not a Meeting) — only the OS-level window title reacts
   *  to this; `title` itself already carries the right body wording either
   *  way (see IncomingMeetingNotice's own `heading`). */
  adhoc: boolean;
  /** The call's own actual type, present only when `adhoc` is true — Accept
   *  joins with this rather than offering a device choice. */
  media?: "video" | "voice";
  /** True once a real call.ring has fired for this invite — see
   *  PlatformConfig.showMeetingInvitePopup's own doc comment. Offers a real
   *  Decline for a MEETING/CHANNEL invite too, not just ad-hoc. */
  ringing?: boolean;
}

declare global {
  interface Window {
    meetingInvite: {
      callId: string;
      title: string;
      organizer: string;
      adhoc: boolean;
      media?: "video" | "voice";
      ringing: boolean;
      onUpdate: (cb: (invite: Invite) => void) => () => void;
      ready: () => void;
      act: (action: "video" | "voice" | "leave" | "decline") => void;
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
      const custom = readStoredCustomTheme();
      applyTheme(
        document.documentElement,
        stored && isThemeId(stored) ? stored : defaultThemeFor(false),
        custom && isCustomThemeActive() ? custom : null,
      );
    };
    apply();
    window.addEventListener("storage", apply);
    return () => window.removeEventListener("storage", apply);
  }, []);
}

function MeetingInviteApp() {
  useSyncedTheme();
  const { t } = useTranslation("stickies");
  const bridge = window.meetingInvite;
  const [invite, setInvite] = useState<Invite>({
    callId: bridge.callId,
    title: bridge.title,
    organizer: bridge.organizer,
    adhoc: bridge.adhoc,
    media: bridge.media,
    ringing: bridge.ringing,
  });
  // The window's OWN OS-level title (taskbar/alt-tab), distinct from the body
  // text above — "Meeting invite" was always wrong for an ad-hoc call, which
  // is never a Meeting. Depends on invite.adhoc, not just `t`: the SAME window
  // is reused and refreshed in place for a later update to the same callId
  // (see MeetingInviteManager's "update" branch), never recreated.
  useEffect(() => {
    document.title = t(invite.adhoc ? "window.titles.call" : "window.titles.invite");
  }, [t, invite.adhoc]);

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
        {invite.adhoc ? (
          // A call rings with exactly two choices — accept it as placed, or
          // reject it. No device picker: invite.media (the call's own
          // actual type) decides what gets joined.
          <>
            <InviteAction
              icon={<Phone size={18} />}
              label={t("window.invite.accept")}
              title={t("window.invite.accept")}
              tone="accent"
              onClick={() => bridge.act(invite.media === "voice" ? "voice" : "video")}
            />
            <InviteAction
              icon={<X size={18} />}
              label={t("window.invite.decline")}
              title={t("window.invite.decline")}
              tone="danger"
              onClick={() => bridge.act("decline")}
            />
          </>
        ) : (
          <>
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
            {invite.ringing ? (
              // A real invitation is open on the server — Decline tells it
              // "no" rather than merely closing this window.
              <InviteAction
                icon={<X size={18} />}
                label={t("window.invite.decline")}
                title={t("window.invite.decline")}
                tone="danger"
                onClick={() => bridge.act("decline")}
              />
            ) : (
              <InviteAction
                icon={<X size={18} />}
                label={t("window.invite.leave")}
                title={t("window.invite.dismiss")}
                tone="danger"
                onClick={() => bridge.act("leave")}
              />
            )}
          </>
        )}
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
