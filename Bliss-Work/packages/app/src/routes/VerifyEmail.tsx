import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("auth");
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
      <AuthLayout title={t("verifyEmail.failed.title")} subtitle={t("verifyEmail.failed.subtitle")}>
        <Link to="/app" className="block text-center text-sm font-medium text-accent hover:underline">
          {t("verifyEmail.backToApp")}
        </Link>
      </AuthLayout>
    );

  if (status === "ok")
    return (
      <AuthLayout title={t("verifyEmail.verified.title")} subtitle={t("verifyEmail.verified.subtitle")}>
        <Link to="/app" className="block text-center text-sm font-medium text-accent hover:underline">
          {t("verifyEmail.verified.continueToApp", { brand: "BlissWork" })}
        </Link>
      </AuthLayout>
    );

  return (
    <AuthLayout
      title={t("verifyEmail.confirm.title")}
      subtitle={valid === null ? t("verifyEmail.confirm.checkingLink") : t("verifyEmail.confirm.subtitle")}
    >
      <Button
        onClick={confirm}
        loading={busy}
        size="lg"
        disabled={valid !== true}
        className="w-full"
      >
        {busy ? t("verifyEmail.confirm.confirming") : t("verifyEmail.confirm.confirmButton")}
      </Button>
    </AuthLayout>
  );
}
