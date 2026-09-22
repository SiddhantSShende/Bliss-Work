import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Mail, Lock, Eye, EyeOff } from "lucide-react";
import { Button, Input } from "@taskboard/ui";
import { ApiError, isCaptchaExemptPlatform, isMfaPending } from "@taskboard/shared";
import { toast } from "sonner";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { broadcastSession } from "../lib/authChannel";
import { AuthLayout, Field } from "./Onboarding";
import { CaptchaField, useCaptcha } from "../features/Captcha";
import { safeRedirect } from "../lib/safeRedirect";
import { detectClientPlatform } from "../lib/clientPlatform";

export function Login() {
  const { t } = useTranslation("auth");
  const { api } = useRuntime();
  const setSession = useSession((s) => s.setSession);
  const nav = useNavigate();
  const [searchParams] = useSearchParams();
  // Where RequireAuth sent this visitor from, e.g. a meeting link — see
  // lib/RequireAuth.tsx. Falls back to /app when absent or unsafe.
  const redirect = safeRedirect(searchParams.get("redirect"));
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [form, setForm] = useState({ email: "", password: "" });
  // macOS and iOS sign in without a CAPTCHA; every other platform keeps it. The
  // server makes the same call from `clientPlatform` — this only decides whether
  // to fetch and show the challenge.
  const [platform] = useState(detectClientPlatform);
  // Set when the server wants a CAPTCHA from a platform this client took to be
  // exempt (client and server out of step, e.g. mid-deploy): show the challenge
  // rather than leave the person unable to sign in.
  const [captchaForced, setCaptchaForced] = useState(false);
  const needsCaptcha = captchaForced || !isCaptchaExemptPlatform(platform);
  const captcha = useCaptcha(needsCaptcha);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const captchaId = needsCaptcha ? captcha.captchaId : null;
    if (needsCaptcha && !captchaId) return;
    setBusy(true);
    try {
      const result = await api.login({
        ...form,
        clientPlatform: platform,
        ...(captchaId ? { captchaId, captchaValue: captcha.value } : {}),
      });
      if (isMfaPending(result)) {
        nav("/mfa-challenge", { state: { ...result, redirect } });
        return;
      }
      setSession({ user: result.user, accessToken: result.accessToken, expiresIn: result.expiresIn });
      broadcastSession(result); // adopt this session in sibling tabs sitting on /login
      // replace: true — /login must not stay in history after a successful
      // sign-in, or the back button lands on a stale login form and forward
      // again could re-attempt redeeming an already-spent meeting token.
      nav(redirect, { replace: true });
    } catch (err) {
      // A bare catch here used to report EVERY failure as bad credentials, which
      // sent people to re-type a password that was never the problem: an
      // unreachable auth-svc (the common one — a dev tunnel forwarding 5173 but
      // not 8001), a CORS rejection and a 500 all look identical to fetch's
      // caller. Only 401 is actually about the credentials.
      if (err instanceof ApiError && err.status === 401) {
        toast.error(t("login.errors.invalidCredentials"));
      } else if (err instanceof ApiError && err.status === 400 && !needsCaptcha) {
        setCaptchaForced(true);
        toast.error(t("login.errors.securityCheckRequiredTitle"), {
          description: t("login.errors.securityCheckRequiredDescription"),
        });
      } else if (err instanceof ApiError && err.status === 400) {
        toast.error(t("login.errors.incorrectSecurityCheckTitle"), {
          description: t("login.errors.incorrectSecurityCheckDescription"),
        });
      } else if (err instanceof ApiError && err.status === 429) {
        toast.error(t("login.errors.tooManyAttemptsTitle"), {
          description: t("login.errors.tooManyAttemptsDescription"),
        });
      } else if (err instanceof ApiError) {
        toast.error(t("login.errors.signInFailedTitle"), {
          description: t("login.errors.signInFailedDescription", { status: err.status }),
        });
      } else {
        // fetch itself threw: DNS, connection refused, TLS, CORS preflight.
        toast.error(t("login.errors.cantReachServerTitle"), {
          description: t("login.errors.cantReachServerDescription"),
        });
      }
      // The CAPTCHA the server just validated is single-use — dead now
      // regardless of WHY the request ultimately failed (wrong password,
      // wrong CAPTCHA, or anything else). A retry needs a fresh one. (Nothing to
      // refresh when none was used; a forced one is fetched by useCaptcha itself.)
      if (needsCaptcha) void captcha.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={t("login.title")} subtitle={t("login.subtitle")}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label={t("login.emailLabel")}>
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
              placeholder={t("login.emailPlaceholder")}
              className="pl-10"
              autoFocus
              required
            />
          </div>
        </Field>
        <Field label={t("login.passwordLabel")}>
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
              title={reveal ? t("login.hidePassword") : t("login.showPassword")}
              aria-label={reveal ? t("login.hidePassword") : t("login.showPassword")}
            >
              {reveal ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </Field>
        <div className="-mt-1 text-right">
          <Link to="/forgot-password" className="text-sm font-medium text-accent hover:underline">
            {t("login.forgotPassword")}
          </Link>
        </div>
        {needsCaptcha && <CaptchaField captcha={captcha} />}
        <Button
          type="submit"
          loading={busy}
          disabled={needsCaptcha && (!captcha.captchaId || captcha.value.length === 0)}
          size="lg"
          className="mt-1 w-full"
        >
          {busy ? t("login.signingIn") : t("login.signIn")}
        </Button>
        <p className="text-center text-sm text-muted">
          {t("login.needWorkspace")}{" "}
          <Link to="/onboarding" className="font-medium text-accent hover:underline">
            {t("login.createOne")}
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
