import { useState } from "react";
import { Link } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { Mail } from "lucide-react";
import { Button, Input } from "@taskboard/ui";
import { ApiError } from "@taskboard/shared";
import { toast } from "sonner";
import { useRuntime } from "../lib/runtime";
import { AuthLayout, Field } from "./Onboarding";

/**
 * Public "forgot password" page. Posts the email to /auth/password/forgot, which
 * always responds 202 whether or not an account exists — so we show the same
 * "check your email" confirmation on success and only surface an error for
 * rate-limiting / malformed input (never account existence).
 */
export function ForgotPassword() {
  const { t } = useTranslation("auth");
  const { api } = useRuntime();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.requestPasswordReset({ email });
      setSent(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        toast.error(t("forgotPassword.errors.tooManyRequests"));
      } else if (err instanceof ApiError && err.status === 422) {
        toast.error(t("forgotPassword.errors.invalidEmail"));
      } else {
        toast.error(t("forgotPassword.errors.generic"));
      }
    } finally {
      setBusy(false);
    }
  };

  if (sent)
    return (
      <AuthLayout
        title={t("forgotPassword.sent.title")}
        subtitle={t("forgotPassword.sent.subtitle")}
      >
        <p className="text-sm leading-relaxed text-muted">
          <Trans
            i18nKey="auth:forgotPassword.sent.expiryNotice"
            components={{
              button: (
                <button
                  type="button"
                  className="font-medium text-accent hover:underline"
                  onClick={() => setSent(false)}
                />
              ),
            }}
          />
        </p>
        <Link
          to="/login"
          className="mt-4 block text-center text-sm font-medium text-accent hover:underline"
        >
          {t("forgotPassword.backToSignIn")}
        </Link>
      </AuthLayout>
    );

  return (
    <AuthLayout title={t("forgotPassword.title")} subtitle={t("forgotPassword.subtitle")}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label={t("forgotPassword.emailLabel")}>
          <div className="relative">
            <Mail
              size={17}
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"
              aria-hidden
            />
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("forgotPassword.emailPlaceholder")}
              className="pl-10"
              autoFocus
              required
            />
          </div>
        </Field>
        <Button type="submit" loading={busy} size="lg" className="mt-1 w-full">
          {busy ? t("forgotPassword.sending") : t("forgotPassword.sendResetLink")}
        </Button>
        <Link to="/login" className="text-center text-sm font-medium text-accent hover:underline">
          {t("forgotPassword.backToSignIn")}
        </Link>
      </form>
    </AuthLayout>
  );
}
