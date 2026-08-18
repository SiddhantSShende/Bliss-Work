import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Mail, Lock, Eye, EyeOff } from "lucide-react";
import { Button, Input } from "@taskboard/ui";
import { ApiError } from "@taskboard/shared";
import { toast } from "sonner";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { broadcastSession } from "../lib/authChannel";
import { AuthLayout, Field } from "./Onboarding";

export function Login() {
  const { api } = useRuntime();
  const setSession = useSession((s) => s.setSession);
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [form, setForm] = useState({ email: "", password: "" });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const s = await api.login(form);
      setSession({ user: s.user, accessToken: s.accessToken });
      broadcastSession(s); // adopt this session in sibling tabs sitting on /login
      nav("/app");
    } catch (err) {
      // A bare catch here used to report EVERY failure as bad credentials, which
      // sent people to re-type a password that was never the problem: an
      // unreachable auth-svc (the common one — a dev tunnel forwarding 5173 but
      // not 8001), a CORS rejection and a 500 all look identical to fetch's
      // caller. Only 401 is actually about the credentials.
      if (err instanceof ApiError && err.status === 401) {
        toast.error("Invalid email or password");
      } else if (err instanceof ApiError && err.status === 429) {
        toast.error("Too many attempts", {
          description: "Wait a minute before trying again.",
        });
      } else if (err instanceof ApiError) {
        toast.error("Sign-in failed", {
          description: `The server returned ${err.status}. Your details were not the problem.`,
        });
      } else {
        // fetch itself threw: DNS, connection refused, TLS, CORS preflight.
        toast.error("Can't reach the server", {
          description: "Check that the auth service is running and reachable from this browser.",
        });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to your workspace.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Email">
          <div className="relative">
            <Mail
              size={17}
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"
              aria-hidden
            />
            <Input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="you@acme.com"
              className="pl-10"
              autoFocus
              required
            />
          </div>
        </Field>
        <Field label="Password">
          <div className="relative">
            <Lock
              size={17}
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"
              aria-hidden
            />
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
              title={reveal ? "Hide password" : "Show password"}
              aria-label={reveal ? "Hide password" : "Show password"}
            >
              {reveal ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </Field>
        <div className="-mt-1 text-right">
          <Link to="/forgot-password" className="text-sm font-medium text-accent hover:underline">
            Forgot password?
          </Link>
        </div>
        <Button type="submit" loading={busy} size="lg" className="mt-1 w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
        <p className="text-center text-sm text-muted">
          Need a workspace?{" "}
          <Link to="/onboarding" className="font-medium text-accent hover:underline">
            Create one
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
