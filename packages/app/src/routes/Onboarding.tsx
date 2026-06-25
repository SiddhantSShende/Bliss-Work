import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Button, Card, Input, Logo } from "@taskboard/ui";
import { toast } from "sonner";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { PasswordField } from "../features/PasswordField";
import { checkPassword } from "../lib/password";

export function Onboarding() {
  const { api } = useRuntime();
  const setSession = useSession((s) => s.setSession);
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ orgName: "", displayName: "", email: "", password: "" });

  const pwOk = checkPassword(form.password).ok;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pwOk) return toast.error("Password must be at least 8 characters with a special character");
    setBusy(true);
    try {
      const s = await api.createOrg(form);
      setSession({ user: s.user, accessToken: s.accessToken });
      nav("/app");
    } catch (err) {
      toast.error("Could not create organization", { description: String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Create your organization" subtitle="Spin up a new BlissWork workspace.">
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        <Field label="Organization name">
          <Input value={form.orgName} onChange={(e) => setForm({ ...form, orgName: e.target.value })} placeholder="Acme Inc." required />
        </Field>
        <Field label="Your name">
          <Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="Ada Lovelace" required />
        </Field>
        <Field label="Email">
          <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="you@acme.com" required />
        </Field>
        <Field label="Password">
          <PasswordField value={form.password} onChange={(v) => setForm({ ...form, password: v })} />
        </Field>
        <Button type="submit" loading={busy} disabled={!pwOk} size="lg" className="mt-2 w-full">
          {busy ? "Creating…" : "Create organization"}
        </Button>
        <p className="mt-1 text-center text-sm text-muted">
          Already have an account?{" "}
          <Link to="/login" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}

export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    // h-full + overflow-y-auto lets tall forms scroll on short screens (the
    // #root ancestor is overflow-hidden); min-h-full keeps it centered when short.
    <div className="relative flex h-full min-h-full items-center justify-center overflow-y-auto p-4 sm:p-6">
      <div className="pointer-events-none fixed inset-0 bg-gradient-to-br from-accent-soft via-bg to-bg" />
      <div className="pointer-events-none fixed -left-24 -top-24 h-72 w-72 rounded-full bg-accent/15 blur-3xl" />
      <div className="pointer-events-none fixed -bottom-24 -right-24 h-72 w-72 rounded-full bg-success/10 blur-3xl" />
      <Card className="glass relative my-auto w-full max-w-md p-6 sm:p-8">
        <div className="mb-7">
          <div className="mb-4 flex items-center gap-2.5">
            <Logo size={36} />
            <span className="text-lg font-semibold tracking-tight text-fg">
              Bliss<span className="text-accent">Work</span>
            </span>
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
        </div>
        {children}
      </Card>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-fg/80">{label}</span>
      {children}
    </label>
  );
}
