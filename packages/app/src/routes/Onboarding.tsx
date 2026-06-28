import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Quote } from "lucide-react";
import { Button, Card, Input, Logo } from "@taskboard/ui";
import { toast } from "sonner";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { broadcastSession } from "../lib/authChannel";
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
      broadcastSession(s);
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

/** Rotating workplace quotes shown on the auth hero panel. */
const AUTH_QUOTES: { text: string; author: string }[] = [
  { text: "Great things in business are never done by one person. They're done by a team.", author: "Steve Jobs" },
  { text: "Alone we can do so little; together we can do so much.", author: "Helen Keller" },
  { text: "Focus on being productive instead of busy.", author: "Tim Ferriss" },
  { text: "The way to get started is to quit talking and begin doing.", author: "Walt Disney" },
  { text: "Simplicity is the soul of efficiency.", author: "Austin Freeman" },
];

function QuoteRotator() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % AUTH_QUOTES.length), 6000);
    return () => clearInterval(t);
  }, []);
  const q = AUTH_QUOTES[i]!;
  return (
    // key={i} re-triggers the entrance animation on every rotation.
    <figure key={i} className="animate-quote">
      <Quote size={28} className="mb-3 text-white/40" aria-hidden />
      <blockquote className="text-pretty text-xl font-medium leading-relaxed text-white/95 sm:text-[1.6rem] sm:leading-snug">
        {q.text}
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
            Where teams find their flow
          </p>
          <QuoteRotator />
        </div>
        <div
          className="animate-fade-in relative text-[13px] text-white/55"
          style={{ animationDelay: "0.3s" }}
        >
          by <span className="font-semibold text-white/85">AEIV Global Private Limited</span>
        </div>
      </aside>

      {/* ── Form side ─────────────────────────────────────────────────────────── */}
      <main className="relative flex flex-1 flex-col items-center justify-center p-4 sm:p-6">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-accent-soft via-bg to-bg" />
        <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-accent/15 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 left-0 h-72 w-72 rounded-full bg-success/10 blur-3xl" />

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
        </Card>

        <p className="relative z-10 mt-5 text-center text-xs text-muted lg:hidden">
          by <span className="font-semibold text-fg/70">AEIV Global Private Limited</span>
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
