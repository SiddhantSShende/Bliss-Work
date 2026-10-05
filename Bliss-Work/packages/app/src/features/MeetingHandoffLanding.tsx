import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@taskboard/ui";
import { AuthLayout } from "../routes/Onboarding";
import { meetingDeepLink } from "../lib/meetingDeepLink";

/** iOS/Android can't run the desktop app — attempting a taskboard:// launch
 *  there just produces a jarring "Cannot open page" prompt before the
 *  visitor ever sees "Continue in Browser". This is a coarse "can this
 *  browser even run our desktop app" precondition, not the UA-based "is the
 *  app installed" detection this feature deliberately avoids elsewhere. */
function isMobileUserAgent(): boolean {
  return /iphone|ipad|ipod|android/i.test(navigator.userAgent);
}

/**
 * The web landing page a meeting's https join link opens to.
 *
 * Attempts to hand off to the desktop app via a `taskboard://` deep link,
 * and always leaves "Continue in Browser" / "Download Desktop App" available
 * regardless of whether that attempt worked — there is no way to reliably
 * tell whether a custom-protocol launch actually succeeded (the protocol
 * being registered doesn't mean the app opened; the app being installed
 * doesn't mean the protocol launch wasn't blocked), so the fallback is never
 * gated on trying to detect that.
 */
export function MeetingHandoffLanding({ token }: { token: string }) {
  const { t } = useTranslation("meetings");
  const nav = useNavigate();
  const [attempted, setAttempted] = useState(false);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (!token || isMobileUserAgent()) return;
    setAttempted(true);
    window.location.href = meetingDeepLink(token);
    const timer = setTimeout(() => {
      if (document.visibilityState === "visible") setTimedOut(true);
    }, 1800);
    return () => clearTimeout(timer);
  }, [token]);

  const continueInBrowser = () => {
    nav(`/join?t=${encodeURIComponent(token)}&via=browser`, { replace: true });
  };

  return (
    <AuthLayout
      title={t("handoff.title")}
      subtitle={t("handoff.subtitle")}
    >
      <div className="flex flex-col gap-4">
        {attempted && (
          <p className="text-center text-sm text-muted">
            {timedOut ? t("handoff.notOpened") : t("handoff.openingApp", { brand: "BlissWork" })}
          </p>
        )}
        <Button size="lg" className="w-full" onClick={continueInBrowser}>
          {t("handoff.continueInBrowser")}
        </Button>
      </div>
    </AuthLayout>
  );
}
