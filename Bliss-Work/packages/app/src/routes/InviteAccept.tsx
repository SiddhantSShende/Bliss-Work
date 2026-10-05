import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button, Input } from "@taskboard/ui";
import { toast } from "sonner";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { broadcastSession } from "../lib/authChannel";
import { AuthLayout, Field } from "./Onboarding";
import { PasswordField } from "../features/PasswordField";
import { checkPassword } from "../lib/password";

export function InviteAccept() {
  const { t } = useTranslation("auth");
  const { api } = useRuntime();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const setSession = useSession((s) => s.setSession);
  const nav = useNavigate();

  const [state, setState] = useState<{ email: string; orgName: string; valid: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ username: "", displayName: "", password: "" });

  useEffect(() => {
    if (!token) return;
    api
      .verifyInvite(token)
      .then(setState)
      .catch(() => setState({ email: "", orgName: "", valid: false }));
  }, [api, token]);

  const pwOk = checkPassword(form.password).ok;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pwOk) return toast.error(t("inviteAccept.errors.passwordPolicy"));
    setBusy(true);
    try {
      const s = await api.acceptInvite({ token, ...form });
      setSession({ user: s.user, accessToken: s.accessToken, expiresIn: s.expiresIn });
      broadcastSession(s);
      nav("/app");
    } catch (err) {
      toast.error(t("inviteAccept.errors.couldNotAcceptInvite"), { description: String(err) });
    } finally {
      setBusy(false);
    }
  };

  if (!token) return <AuthLayout title={t("inviteAccept.invalid.title")}>{t("inviteAccept.invalid.message")}</AuthLayout>;
  if (state && !state.valid)
    return <AuthLayout title={t("inviteAccept.expired.title")}>{t("inviteAccept.expired.message")}</AuthLayout>;

  return (
    <AuthLayout
      title={t("inviteAccept.joinTitle", { orgName: state?.orgName ?? "…" })}
      subtitle={state ? t("inviteAccept.invitedAs", { email: state.email }) : t("inviteAccept.verifyingInvite")}
    >
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        <Field label={t("inviteAccept.usernameLabel")}>
          <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder={t("inviteAccept.usernamePlaceholder")} required />
        </Field>
        <Field label={t("inviteAccept.displayNameLabel")}>
          <Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder={t("inviteAccept.displayNamePlaceholder")} required />
        </Field>
        <Field label={t("inviteAccept.passwordLabel")}>
          <PasswordField value={form.password} onChange={(v) => setForm({ ...form, password: v })} />
        </Field>
        <Button type="submit" loading={busy} size="lg" disabled={!state?.valid || !pwOk} className="mt-2 w-full">
          {busy ? t("inviteAccept.joining") : t("inviteAccept.joinWorkspace")}
        </Button>
      </form>
    </AuthLayout>
  );
}
