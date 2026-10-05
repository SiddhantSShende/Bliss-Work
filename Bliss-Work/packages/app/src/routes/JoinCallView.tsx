import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Video, AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, EmptyState } from "@taskboard/ui";
import type { CallDTO } from "@taskboard/shared";
import { useConnectEventBridge, useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { useMeetingSession } from "../lib/MeetingSession";
import { RequireAuth } from "../lib/RequireAuth";
import { MeetingHandoffLanding } from "../features/MeetingHandoffLanding";

/**
 * How long this route waits for the meeting overlay (MeetingHost/CallRoom) to
 * take over before offering a way out. Below this, the route has no fallback
 * of its own at all: a stall anywhere in enter()/MeetingHost's render
 * (whatever the cause) leaves the visitor staring at inert placeholder text
 * with no error and no recourse — exactly the failure mode CallWindow.tsx's
 * own doc comment describes for /call/:callId. CallWindow eliminated it
 * structurally, by rendering CallRoom directly instead of trusting a
 * hand-off at all; this route still uses the hand-off pattern (see `enter`
 * below), so it needs a runtime guard instead — see `HandOff` below.
 */
const HANDOFF_TIMEOUT_MS = 15_000;

/**
 * Entry point for a meeting link: /join?t=<token>
 *
 * On the web, a fresh visit (no `via=browser` yet) shows the desktop-handoff
 * landing page first — signed in or not, since the whole point is to offer a
 * choice BEFORE gating on authentication. Choosing "Continue in Browser"
 * there re-enters this component with `via=browser`, which — like Electron,
 * which always skips the landing page (handing off to itself is pointless)
 * — falls through to the actual redemption, gated on being signed in.
 */
export function JoinCallView() {
  const { config } = useRuntime();
  const [params] = useSearchParams();
  const token = params.get("t") ?? "";
  const via = params.get("via");

  if (token && config.kind === "web" && via !== "browser") {
    return <MeetingHandoffLanding token={token} />;
  }

  return (
    <RequireAuth>
      <JoinCallRedeem token={token} />
    </RequireAuth>
  );
}

/**
 * Redeems a meeting invite link.
 *
 * This is the ONLY cross-organisation door in the product. Two things about it
 * are deliberate and worth not "simplifying" later:
 *
 *  1. It still requires a signed-in BlissWork account. The link is not an
 *     anonymous guest pass — it grants a seat to a real, authenticated user,
 *     whoever they turn out to be. That is what keeps the participant roster
 *     meaningful and the audit trail honest.
 *
 *  2. The joiner's own organisation is irrelevant to the decision. The server
 *     records them with THEIR org id, which is what marks them "external" in
 *     the roster and what lets their own org's row-level security see the
 *     meeting at all.
 *
 * Every failure — unknown, expired, revoked, already spent — is reported
 * identically, because the server deliberately cannot tell them apart. Being
 * more specific would turn this page into an oracle for guessing tokens.
 */
function JoinCallRedeem({ token }: { token: string }) {
  const { t } = useTranslation("calls");
  const { api } = useRuntime();
  const nav = useNavigate();
  const me = useSession((s) => s.user);
  const [call, setCall] = useState<CallDTO | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(true);

  // This route sits outside /app (see App.tsx's own comment on why), so
  // WsEventBridge — mounted only inside AppShell — never runs here. CallWindow
  // needs the identical fix for /call/:callId, the other route outside /app;
  // without it, someone joining by link never hears CallStarted (the pre-join
  // lobby's auto-join in useCallRoom) or CallEnded live — only ever the 30s
  // lobby-poll fallback.
  useConnectEventBridge();

  useEffect(() => {
    if (!token) {
      setFailed(true);
      setPending(false);
      return;
    }
    // Wait for the session to resolve. Redeeming without one would spend a
    // single-use link on a request that is about to 401.
    if (!me) return;
    let cancelled = false;
    api
      .joinCallByToken(token)
      .then((c) => {
        if (!cancelled) setCall(c);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, token, me]);

  if (!me) {
    return (
      <div className="meeting-surface meeting-theme meeting-mesh fixed inset-0 flex items-center justify-center p-6">
        <EmptyState
          icon={<Video size={24} />}
          title={t("join.signIn.title")}
          hint={t("join.signIn.hint", { brand: "BlissWork" })}
        />
      </div>
    );
  }

  if (pending) {
    return (
      <div className="meeting-surface meeting-theme meeting-mesh fixed inset-0 flex items-center justify-center text-sm text-muted">
        {t("join.joining")}
      </div>
    );
  }

  if (failed || !call) {
    return (
      <div className="meeting-surface meeting-theme meeting-mesh fixed inset-0 flex flex-col items-center justify-center gap-4 p-6">
        <EmptyState
          icon={<AlertCircle size={24} />}
          title={t("join.invalid.title")}
          hint={t("join.invalid.hint")}
        />
        <Button variant="ghost" size="sm" onClick={() => nav("/app")}>
          {t("join.invalid.backToApp", { brand: "BlissWork" })}
        </Button>
      </div>
    );
  }

  // Handed to the session above the router — see routes/CallWindow for why the
  // room is never rendered by a route any more.
  return <HandOff call={call} />;
}

/**
 * Ask the session for this meeting, and show that it is happening.
 *
 * A component rather than an effect in the view above it because the hand-off
 * has to happen AFTER the call row resolves, and only once.
 */
function HandOff({ call }: { call: CallDTO }) {
  const { t } = useTranslation("calls");
  const { enter, call: active } = useMeetingSession();
  const nav = useNavigate();
  useEffect(() => {
    if (active?.id === call.id) return;
    enter(call, () => nav("/app"));
  }, [call, active?.id, enter, nav]);

  // A bounded backstop for the same handoff CallWindow guards against: if the
  // overlay hasn't taken over within HANDOFF_TIMEOUT_MS, offer a reload
  // instead of leaving "Joining the meeting…" on screen forever. Harmless if
  // the overlay DID mount by then — it covers this route entirely (fixed
  // inset-0, see CallRoomLazy), so this fallback renders invisibly
  // underneath it.
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    setTimedOut(false);
    const timer = setTimeout(() => setTimedOut(true), HANDOFF_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [call.id]);

  if (timedOut) {
    return (
      <div className="meeting-surface meeting-theme meeting-mesh fixed inset-0 flex flex-col items-center justify-center gap-4 p-6">
        <EmptyState
          icon={<AlertCircle size={24} />}
          title={t("join.timeout.title")}
          hint={t("join.timeout.hint")}
        />
        <Button variant="ghost" size="sm" onClick={() => window.location.reload()}>
          {t("join.timeout.reload")}
        </Button>
      </div>
    );
  }

  return (
    <div className="meeting-surface meeting-theme meeting-mesh fixed inset-0 flex items-center justify-center text-sm text-muted">
      {t("join.handoff.joining")}
    </div>
  );
}
