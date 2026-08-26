import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, Input } from "@taskboard/ui";
import { toast } from "sonner";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { broadcastSession } from "../lib/authChannel";
import { AuthLayout, Field } from "./Onboarding";
import { PasswordField } from "../features/PasswordField";
import { checkPassword } from "../lib/password";

export function InviteAccept() {
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
    if (!pwOk) return toast.error("Password must be at least 10 characters with a letter, a number, and a special character");
    setBusy(true);
    try {
      const s = await api.acceptInvite({ token, ...form });
      setSession({ user: s.user, accessToken: s.accessToken, expiresIn: s.expiresIn });
      broadcastSession(s);
      nav("/app");
    } catch (err) {
      toast.error("Could not accept invite", { description: String(err) });
    } finally {
      setBusy(false);
    }
  };

  if (!token) return <AuthLayout title="Invalid invite">Missing invite token.</AuthLayout>;
  if (state && !state.valid)
    return <AuthLayout title="Invite expired">This invite is no longer valid.</AuthLayout>;

  return (
    <AuthLayout
      title={`Join ${state?.orgName ?? "…"}`}
      subtitle={state ? `Invited as ${state.email}` : "Verifying invite…"}
    >
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        <Field label="Username">
          <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="ada" required />
        </Field>
        <Field label="Display name">
          <Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="Ada Lovelace" required />
        </Field>
        <Field label="Password">
          <PasswordField value={form.password} onChange={(v) => setForm({ ...form, password: v })} />
        </Field>
        <Button type="submit" loading={busy} size="lg" disabled={!state?.valid || !pwOk} className="mt-2 w-full">
          {busy ? "Joining…" : "Join workspace"}
        </Button>
      </form>
    </AuthLayout>
  );
}
