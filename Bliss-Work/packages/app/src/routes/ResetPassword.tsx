import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@taskboard/ui";
import { ApiError } from "@taskboard/shared";
import { toast } from "sonner";
import { useRuntime } from "../lib/runtime";
import { AuthLayout, Field } from "./Onboarding";
import { PasswordField } from "../features/PasswordField";
import { checkPassword } from "../lib/password";

/**
 * Public "set a new password" page reached from the emailed reset link. Mirrors
 * InviteAccept: verify the token on mount, collect a policy-compliant password,
 * submit, then send the user to /login (we deliberately do NOT auto-login — the
 * reset revokes every session server-side, so re-auth confirms the new password).
 */
export function ResetPassword() {
  const { t } = useTranslation("auth");
  const { api } = useRuntime();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const nav = useNavigate();

  const [valid, setValid] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (!token) {
      setValid(false);
      return;
    }
    api
      .verifyResetToken(token)
      .then((r) => setValid(r.valid))
      .catch(() => setValid(false));
  }, [api, token]);

  const pwOk = checkPassword(password).ok;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pwOk)
      return toast.error(t("resetPassword.errors.passwordPolicy"));
    setBusy(true);
    try {
      await api.resetPassword({ token, password });
      toast.success(t("resetPassword.success"));
      nav("/login");
    } catch (err) {
      const expired = err instanceof ApiError && err.status === 400;
      toast.error(t("resetPassword.errors.couldNotResetTitle"), {
        description: expired ? t("resetPassword.errors.linkInvalidOrExpired") : String(err),
      });
      if (expired) setValid(false);
    } finally {
      setBusy(false);
    }
  };

  if (!token || valid === false)
    return (
      <AuthLayout title={t("resetPassword.expired.title")} subtitle={t("resetPassword.expired.subtitle")}>
        <Link
          to="/forgot-password"
          className="block text-center text-sm font-medium text-accent hover:underline"
        >
          {t("resetPassword.expired.requestNewLink")}
        </Link>
      </AuthLayout>
    );

  return (
    <AuthLayout
      title={t("resetPassword.title")}
      subtitle={valid === null ? t("resetPassword.verifyingLink") : t("resetPassword.subtitle")}
    >
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        <Field label={t("resetPassword.newPasswordLabel")}>
          <PasswordField value={password} onChange={setPassword} />
        </Field>
        <Button
          type="submit"
          loading={busy}
          size="lg"
          disabled={valid !== true || !pwOk}
          className="mt-2 w-full"
        >
          {busy ? t("resetPassword.updating") : t("resetPassword.updatePassword")}
        </Button>
      </form>
    </AuthLayout>
  );
}
