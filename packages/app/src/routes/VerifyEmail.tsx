import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useRuntime } from "../lib/runtime";
import { AuthLayout } from "./Onboarding";

/**
 * Public landing page for the emailed verification link. Consumes the token on
 * mount (single-use) and shows the outcome. Reached whether or not the user is
 * currently signed in — the token itself is the credential.
 */
export function VerifyEmail() {
  const { api } = useRuntime();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [status, setStatus] = useState<"pending" | "ok" | "error">(token ? "pending" : "error");
  const ran = useRef(false);

  useEffect(() => {
    if (!token || ran.current) return;
    ran.current = true;
    api
      .verifyEmail(token)
      .then(() => setStatus("ok"))
      .catch(() => setStatus("error"));
  }, [api, token]);

  const title =
    status === "ok" ? "Email verified" : status === "pending" ? "Verifying…" : "Verification failed";
  const subtitle =
    status === "ok"
      ? "Thanks — your email address is confirmed."
      : status === "pending"
        ? "Hang tight while we confirm your email."
        : "This verification link is invalid or has expired.";

  return (
    <AuthLayout title={title} subtitle={subtitle}>
      {status !== "pending" && (
        <Link to="/app" className="block text-center text-sm font-medium text-accent hover:underline">
          {status === "ok" ? "Continue to BlissWork" : "Back to app"}
        </Link>
      )}
    </AuthLayout>
  );
}
