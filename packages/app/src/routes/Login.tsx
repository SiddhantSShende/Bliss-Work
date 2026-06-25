import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, Input } from "@taskboard/ui";
import { toast } from "sonner";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { AuthLayout, Field } from "./Onboarding";

export function Login() {
  const { api } = useRuntime();
  const setSession = useSession((s) => s.setSession);
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ email: "", password: "" });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const s = await api.login(form);
      setSession({ user: s.user, accessToken: s.accessToken });
      nav("/app");
    } catch {
      toast.error("Invalid email or password");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to your workspace.">
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        <Field label="Email">
          <Input
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="you@acme.com"
            autoFocus
            required
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required
          />
        </Field>
        <Button type="submit" loading={busy} size="lg" className="mt-2 w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
        <p className="mt-1 text-center text-sm text-muted">
          Need a workspace?{" "}
          <Link to="/onboarding" className="font-medium text-accent hover:underline">
            Create one
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
