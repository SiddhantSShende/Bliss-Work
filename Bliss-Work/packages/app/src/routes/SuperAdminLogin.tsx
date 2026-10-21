import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Mail, Lock, Eye, EyeOff } from "lucide-react";
import { Button, Input } from "@taskboard/ui";
import { toast } from "sonner";
import { useRuntime } from "../lib/runtime";
import {
  SuperAdminAuthError,
  getSuperAdminToken,
  setSuperAdminToken,
  superAdminLogin,
  superAdminMe,
} from "../lib/superAdminAuth";
import { AuthLayout, Field } from "./Onboarding";

/**
 * /super-admin/login — intentionally just email, password and a submit
 * button. No registration/create-account link, no CAPTCHA, no "need a
 * workspace?" prompt: this is a single operator credential configured
 * server-side (see auth-svc/app/routes/super_admin.py), never something a
 * visitor creates here. Wholly separate from Login.tsx, which keeps
 * handling the normal multi-tenant org sign-in unchanged.
 */
export function SuperAdminLogin() {
  const { config } = useRuntime();
  const nav = useNavigate();
  const [form, setForm] = useState({ email: "", password: "" });
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  // If a still-valid token already sits in this tab, skip straight to the
  // dashboard rather than showing the form again (point 3 of the brief).
  const [checkingExisting, setCheckingExisting] = useState(true);

  useEffect(() => {
    const existing = getSuperAdminToken();
    if (!existing) {
      setCheckingExisting(false);
      return;
    }
    let cancelled = false;
    void superAdminMe(config.authBase, existing).then((email) => {
      if (cancelled) return;
      if (email) {
        nav("/super-admin/dashboard", { replace: true });
      } else {
        setCheckingExisting(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [config.authBase, nav]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const session = await superAdminLogin(config.authBase, form.email, form.password);
      setSuperAdminToken(session.accessToken);
      // `justLoggedIn` + the email we already have tells the dashboard it can
      // render immediately instead of blocking on its own /me round-trip —
      // this response IS that same server's authorization, issued seconds ago.
      // See SuperAdminDashboard: direct navigation/refresh still blocks on /me.
      nav("/super-admin/dashboard", { replace: true, state: { justLoggedIn: true, email: session.email } });
    } catch (err) {
      if (err instanceof SuperAdminAuthError && err.status === 401) {
        toast.error("Invalid credentials");
      } else if (err instanceof SuperAdminAuthError && err.status === 503) {
        toast.error("Super Admin login is not configured", {
          description: "Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD_HASH on the server.",
        });
      } else if (err instanceof SuperAdminAuthError && err.status === 429) {
        toast.error("Too many attempts", { description: "Please wait a minute and try again." });
      } else {
        toast.error("Couldn't reach the server");
      }
    } finally {
      setBusy(false);
    }
  };

  if (checkingExisting) return null;

  return (
    <AuthLayout title="Super Admin" subtitle="Platform administration sign-in.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Email">
          <div className="relative">
            <Mail size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
            <Input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="pl-10"
              autoFocus
              required
            />
          </div>
        </Field>
        <Field label="Password">
          <div className="relative">
            <Lock size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
            <Input
              type={reveal ? "text" : "password"}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="••••••••"
              className="pl-10 pr-10"
              required
            />
            <button
              type="button"
              onClick={() => setReveal((r) => !r)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted transition-colors hover:text-fg"
              aria-label={reveal ? "Hide password" : "Show password"}
            >
              {reveal ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </Field>
        <Button type="submit" loading={busy} size="lg" className="mt-1 w-full">
          {busy ? "Signing in…" : "Log in"}
        </Button>
      </form>
    </AuthLayout>
  );
}
