import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Video, AlertCircle } from "lucide-react";
import { Button, EmptyState } from "@taskboard/ui";
import type { CallDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { CallRoom } from "../features/CallRoomLazy";

/**
 * Redeems a meeting invite link: /join?t=<token>
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
export function JoinCallView() {
  const [params] = useSearchParams();
  const token = params.get("t") ?? "";
  const { api } = useRuntime();
  const nav = useNavigate();
  const me = useSession((s) => s.user);
  const [call, setCall] = useState<CallDTO | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState(true);

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
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={<Video size={24} />}
          title="Sign in to join"
          hint="This meeting link works with any BlissWork account, including one in another organisation."
        />
      </div>
    );
  }

  if (pending) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        Joining…
      </div>
    );
  }

  if (failed || !call) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
        <EmptyState
          icon={<AlertCircle size={24} />}
          title="This invite link is no longer valid"
          hint="It may have expired, been revoked, or the meeting has already ended. Ask the organiser for a new one."
        />
        <Button variant="ghost" size="sm" onClick={() => nav("/app")}>
          Back to BlissWork
        </Button>
      </div>
    );
  }

  return <CallRoom call={call} onClose={() => nav("/app")} />;
}
