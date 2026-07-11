import { useState } from "react";
import { Link } from "react-router-dom";
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
        toast.error("Too many requests — please wait a minute and try again.");
      } else if (err instanceof ApiError && err.status === 422) {
        toast.error("Please enter a valid email address.");
      } else {
        toast.error("Something went wrong. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  if (sent)
    return (
      <AuthLayout
        title="Check your email"
        subtitle="If an account exists for that address, we've sent a password reset link."
      >
        <p className="text-sm leading-relaxed text-muted">
          The link expires in 30 minutes. Didn't get it? Check your spam folder, or{" "}
          <button
            className="font-medium text-accent hover:underline"
            onClick={() => setSent(false)}
          >
            try a different email
          </button>
          .
        </p>
        <Link
          to="/login"
          className="mt-4 block text-center text-sm font-medium text-accent hover:underline"
        >
          Back to sign in
        </Link>
      </AuthLayout>
    );

  return (
    <AuthLayout title="Forgot your password?" subtitle="Enter your email and we'll send a reset link.">
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
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@acme.com"
              className="pl-10"
              autoFocus
              required
            />
          </div>
        </Field>
        <Button type="submit" loading={busy} size="lg" className="mt-1 w-full">
          {busy ? "Sending…" : "Send reset link"}
        </Button>
        <Link to="/login" className="text-center text-sm font-medium text-accent hover:underline">
          Back to sign in
        </Link>
      </form>
    </AuthLayout>
  );
}
