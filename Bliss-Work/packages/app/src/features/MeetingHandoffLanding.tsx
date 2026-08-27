import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@taskboard/ui";
import { AuthLayout } from "../routes/Onboarding";
import { meetingDeepLink } from "../lib/meetingDeepLink";
import { GetAppButton } from "./GetAppButton";

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
      title="Join Meeting"
      subtitle="You can join this meeting using the desktop app or continue directly in your browser."
    >
      <div className="flex flex-col gap-4">
        {attempted && (
          <p className="text-center text-sm text-muted">
            {timedOut ? "Didn't open automatically." : "Opening the BlissWork desktop app…"}
          </p>
        )}
        <Button size="lg" className="w-full" onClick={continueInBrowser}>
          Continue in Browser
        </Button>
        <GetAppButton mode="inline" />
      </div>
    </AuthLayout>
  );
}
