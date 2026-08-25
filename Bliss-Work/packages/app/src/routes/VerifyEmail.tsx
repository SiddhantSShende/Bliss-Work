import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { AuthLayout } from "./Onboarding";

/**
 * Public landing page for the emailed verification link. Reached whether or
 * not the user is currently signed in — the token itself is the credential.
 *
 * Peeks the token's validity on mount (read-only, does not consume) and
 * requires an explicit click to actually confirm — mirrors ResetPassword /
 * InviteAccept. The token was previously consumed straight from a bare
 * `useEffect`, which an email client's link-preview/scanner bot can trigger
 * before the real user ever sees the page, burning the single-use token. The
 * token staying in the URL is unchanged and fine; only the auto-consumption
 * was the bug. See docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 4.
 */
export function VerifyEmail() {
  const { api } = useRuntime();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";

  const [valid, setValid] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"pending" | "ok" | "error">("pending");

  useEffect(() => {
    if (!token) {
      setValid(false);
      return;
    }
    api
      .verifyEmailToken(token)
      .then((r) => setValid(r.valid))
      .catch(() => setValid(false));
  }, [api, token]);

  const confirm = async () => {
    setBusy(true);
    try {
      await api.verifyEmail(token);
      setStatus("ok");
    } catch {
      setStatus("error");
      setValid(false);
    } finally {
      setBusy(false);
    }
  };

  if (!token || valid === false)
    return (
      <AuthLayout title="Verification failed" subtitle="This verification link is invalid or has expired.">
        <Link to="/app" className="block text-center text-sm font-medium text-accent hover:underline">
          Back to app
        </Link>
      </AuthLayout>
    );

  if (status === "ok")
    return (
      <AuthLayout title="Email verified" subtitle="Thanks — your email address is confirmed.">
        <Link to="/app" className="block text-center text-sm font-medium text-accent hover:underline">
          Continue to BlissWork
        </Link>
      </AuthLayout>
    );

  return (
    <AuthLayout
      title="Confirm your email"
      subtitle={valid === null ? "Checking your link…" : "Click below to confirm this is your email address."}
    >
      <Button
        onClick={confirm}
        loading={busy}
        size="lg"
        disabled={valid !== true}
        className="w-full"
      >
        {busy ? "Confirming…" : "Confirm your email"}
      </Button>
    </AuthLayout>
  );
}
