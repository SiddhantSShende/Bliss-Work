import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { Quote } from "lucide-react";
import { Button, Card, Input, Logo } from "@taskboard/ui";
import { ApiError, isMfaPending } from "@taskboard/shared";
import { toast } from "sonner";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { broadcastSession } from "../lib/authChannel";
import { PasswordField } from "../features/PasswordField";
import { GetAppButton } from "../features/GetAppButton";
import { checkPassword } from "../lib/password";
import { CaptchaField, useCaptcha } from "../features/Captcha";
import { LanguageSwitcher } from "../i18n/LanguageSwitcher";

export function Onboarding() {
  const { t } = useTranslation("auth");
  const { api } = useRuntime();
  const setSession = useSession((s) => s.setSession);
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ orgName: "", displayName: "", email: "", password: "" });
  const captcha = useCaptcha();

  const pwOk = checkPassword(form.password).ok;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pwOk) return toast.error(t("onboarding.errors.passwordPolicy"));
    if (!captcha.captchaId) return;
    setBusy(true);
    try {
      const s = await api.createOrg({
        ...form,
        captchaId: captcha.captchaId,
        captchaValue: captcha.value,
      });
      // An existing identity with MFA enrolled gets the same challenge /login
      // would: the org is created, and the challenge signs them into it.
      if (isMfaPending(s)) {
        nav("/mfa-challenge", { state: { ...s } });
        return;
      }
      setSession({ user: s.user, accessToken: s.accessToken, expiresIn: s.expiresIn });
      broadcastSession(s);
      nav("/app");
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        toast.error(t("onboarding.errors.incorrectSecurityCheckTitle"), { description: t("onboarding.errors.incorrectSecurityCheckDescription") });
      } else {
        toast.error(t("onboarding.errors.couldNotCreateOrg"), { description: String(err) });
      }
      // Single-use: the CAPTCHA the server just validated is dead now
      // regardless of why the request ultimately failed — a retry needs a
      // fresh one.
      void captcha.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={t("onboarding.title")} subtitle={t("onboarding.subtitle", { brand: "BlissWork" })}>
      <form onSubmit={submit} className="flex flex-col gap-3.5">
        <Field label={t("onboarding.orgNameLabel")}>
          <Input value={form.orgName} onChange={(e) => setForm({ ...form, orgName: e.target.value })} placeholder={t("onboarding.orgNamePlaceholder")} required />
        </Field>
        <Field label={t("onboarding.yourNameLabel")}>
          <Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder={t("onboarding.yourNamePlaceholder")} required />
        </Field>
        <Field label={t("onboarding.emailLabel")}>
          <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder={t("onboarding.emailPlaceholder")} required />
        </Field>
        <Field label={t("onboarding.passwordLabel")}>
          <PasswordField value={form.password} onChange={(v) => setForm({ ...form, password: v })} />
        </Field>
        <CaptchaField captcha={captcha} />
        <Button
          type="submit"
          loading={busy}
          disabled={!pwOk || !captcha.captchaId || captcha.value.length === 0}
          size="lg"
          className="mt-2 w-full"
        >
          {busy ? t("onboarding.creating") : t("onboarding.createOrganization")}
        </Button>
        <p className="mt-1 text-center text-sm text-muted">
          {t("onboarding.alreadyHaveAccount")}{" "}
          <Link to="/login" className="font-medium text-accent hover:underline">
            {t("onboarding.signIn")}
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}

/** Rotating workplace quotes shown on the auth hero panel. Authors are real
 *  people, so their names stay as plain literals — only the quote text
 *  itself is translated. */
const AUTH_QUOTES: { textKey: string; author: string }[] = [
  { textKey: "onboarding.quotes.teamwork", author: "Steve Jobs" },
  { textKey: "onboarding.quotes.together", author: "Helen Keller" },
  { textKey: "onboarding.quotes.productive", author: "Tim Ferriss" },
  { textKey: "onboarding.quotes.getStarted", author: "Walt Disney" },
  { textKey: "onboarding.quotes.simplicity", author: "Austin Freeman" },
];

function QuoteRotator() {
  const { t } = useTranslation("auth");
  const [i, setI] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setI((n) => (n + 1) % AUTH_QUOTES.length), 6000);
    return () => clearInterval(interval);
  }, []);
  const q = AUTH_QUOTES[i]!;
  return (
    // key={i} re-triggers the entrance animation on every rotation.
    <figure key={i} className="animate-quote">
      <Quote size={28} className="mb-3 text-white/40" aria-hidden />
      <blockquote className="text-pretty text-xl font-medium leading-relaxed text-white/95 sm:text-[1.6rem] sm:leading-snug">
        {t(q.textKey)}
      </blockquote>
      <figcaption className="mt-4 text-sm font-medium text-white/65">— {q.author}</figcaption>
      <div className="mt-7 flex gap-1.5" aria-hidden>
        {AUTH_QUOTES.map((_, n) => (
          <span
            key={n}
            className={`h-1.5 rounded-full transition-all duration-500 ${
              n === i ? "w-6 bg-white/80" : "w-1.5 bg-white/30"
            }`}
          />
        ))}
      </div>
    </figure>
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
  const { t } = useTranslation("auth");
  return (
    // h-full + overflow-y-auto lets tall forms scroll on short screens (the
    // #root ancestor is overflow-hidden).
    <div className="relative flex h-full min-h-full w-full overflow-y-auto">
      {/* ── Brand hero (lg and up) ── animated gradient, constellation, quotes ── */}
      <aside className="auth-hero relative hidden w-[46%] shrink-0 flex-col justify-between p-10 text-white lg:flex xl:w-1/2 xl:p-16">
        <div className="auth-grid pointer-events-none absolute inset-0" />
        <div className="animate-fade-up relative flex items-center gap-2.5">
          <Logo size={34} />
          <span className="text-lg font-semibold tracking-tight">
            Bliss<span className="text-white/70">Work</span>
          </span>
        </div>
        <div className="animate-fade-up relative max-w-xl" style={{ animationDelay: "0.1s" }}>
          <p className="mb-6 text-[13px] font-medium uppercase tracking-[0.22em] text-white/55">
            {t("onboarding.authLayout.tagline")}
          </p>
          <QuoteRotator />
        </div>
        <div
          className="animate-fade-in relative text-[13px] text-white/55"
          style={{ animationDelay: "0.3s" }}
        >
          <Trans
            i18nKey="auth:onboarding.authLayout.poweredBy"
            components={{ company: <span className="font-semibold text-white/85" /> }}
          />
        </div>
      </aside>

      {/* ── Form side ─────────────────────────────────────────────────────────── */}
      <main className="relative flex flex-1 flex-col items-center justify-center p-4 sm:p-6">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-surface-2 via-bg to-bg" />
        {/* Reachable before sign-in, so someone who cannot read the current language can change it. */}
        <div className="absolute right-3 top-3 z-20 sm:right-5 sm:top-5">
          <LanguageSwitcher />
        </div>

        <Card className="glass animate-fade-up relative z-10 my-auto w-full max-w-md p-6 shadow-card sm:p-8">
          <div className="mb-7">
            {/* Logo on the card for mobile, where the hero panel is hidden. */}
            <div className="mb-5 flex items-center gap-2.5 lg:hidden">
              <Logo size={34} />
              <span className="text-lg font-semibold tracking-tight text-fg">
                Bliss<span className="text-accent">Work</span>
              </span>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
            {subtitle && <p className="mt-1.5 text-sm text-muted">{subtitle}</p>}
          </div>
          {children}
          {/* Desktop-app download (web only; hidden inside the Electron build). */}
          <div className="mt-6">
            <GetAppButton mode="inline" />
          </div>
        </Card>

        <p className="relative z-10 mt-5 text-center text-xs text-muted lg:hidden">
          <Trans
            i18nKey="auth:onboarding.authLayout.poweredBy"
            components={{ company: <span className="font-semibold text-fg/70" /> }}
          />
        </p>
      </main>
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
