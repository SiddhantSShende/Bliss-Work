import { Link } from "react-router-dom";
import {
  ArrowRight,
  Download,
  Globe,
  Hash,
  MessageSquare,
  Mail,
  Send,
  Inbox,
  GlobeLock,
  Zap,
  Pin,
  Lock,
  Database,
  KeyRound,
  ScrollText,
  ShieldCheck,
} from "lucide-react";
import {
  Avatar,
  Badge,
  Button,
  ButtonLink,
  button,
  Card,
  Container,
  Eyebrow,
  Section,
  SectionHeading,
} from "@/components/ui";
import { Reveal, RevealGroup, RevealItem } from "@/components/Reveal";
import { HeroVisual, StickyNote } from "@/components/mockup/ProductMockup";
import { OsGlyph } from "@/components/brand/OsGlyph";
import { useDownload } from "@/components/download/DownloadProvider";
import { PLATFORM_ORDER, PLATFORMS } from "@/config/downloads";
import { SITE } from "@/config/site";

const FEATURES = [
  {
    icon: Hash,
    title: "Channels for every team",
    desc: "Spin up a channel for a project, a squad, or a topic. Everyone who needs the context is in — and everyone who doesn't, isn't.",
  },
  {
    icon: MessageSquare,
    title: "Direct messages, focused",
    desc: "Every message is Reply or Ignore. Ignore quietly clears the thread for both people, so your DMs only hold what actually needs you.",
  },
  {
    icon: Mail,
    title: "Internal mail, sealed in",
    desc: "Full, threaded mail for what's on the record — addressed and composed like email, but it never leaves your network. No external SMTP, no inbound spam.",
  },
  {
    icon: Inbox,
    title: "One calm inbox",
    desc: "Mentions, replies, mail, and assigned tasks gather in a single inbox that surfaces only what's addressed to you — and nothing that isn't.",
  },
  {
    icon: GlobeLock,
    title: "A closed network",
    desc: "It's just you and your team. No public directory, no outside accounts, no one you didn't invite. Your network ends at your organization.",
  },
  {
    icon: Zap,
    title: "Real-time, everywhere",
    desc: "A WebSocket gateway fans out every message and update instantly — in sync across web and desktop, with no refresh and no polling.",
  },
];

const NETWORK = [
  { name: "Alice Reed", presence: "online" as const },
  { name: "Bob Lane", presence: "online" as const },
  { name: "Carol Vance", presence: "away" as const },
  { name: "Dan Brooks", presence: "online" as const },
];

const SECURITY = [
  { icon: Lock, title: "Encrypted at rest", desc: "AES-256-GCM with a per-org data key, KMS-wrapped and crypto-shreddable." },
  { icon: Database, title: "Row-level isolation", desc: "Postgres RLS, fail-closed — one org can never read another's messages." },
  { icon: KeyRound, title: "Asymmetric auth", desc: "EdDSA / JWKS tokens, verified per service. No shared secrets, ever." },
  { icon: ScrollText, title: "Tamper-evident audit", desc: "A hash-chained audit log makes history verifiable for compliance." },
];

export default function Home() {
  const { getApp } = useDownload();

  return (
    <>
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <header className="brand-mesh relative overflow-hidden">
        <Container className="grid items-center gap-14 pb-24 pt-32 lg:grid-cols-[1.05fr_1fr] lg:pb-28 lg:pt-36">
          <div>
            <Reveal>
              <Eyebrow>The enterprise communication network</Eyebrow>
            </Reveal>
            <Reveal delay={0.05}>
              <h1 className="mt-5 text-balance text-4xl font-semibold leading-[1.05] tracking-tight text-fg sm:text-5xl lg:text-6xl">
                Your team's own <span className="text-gradient">private network.</span>
              </h1>
            </Reveal>
            <Reveal delay={0.1}>
              <p className="mt-5 max-w-xl text-pretty text-lg leading-relaxed text-muted">
                BlissWork is where your enterprise talks — channels for every project, direct messages that
                respect your attention, internal mail that never leaves your network, and one calm inbox that
                shows only what needs you. It's just you and the people you work with: no strangers, no noise.
                <span className="text-fg"> (And the tasks? They pin themselves to your desktop.)</span>
              </p>
            </Reveal>
            <Reveal delay={0.15}>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Button size="xl" onClick={getApp}>
                  <Download size={17} />
                  Get the App
                </Button>
                <ButtonLink
                  size="xl"
                  variant="secondary"
                  href={SITE.webApp}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Globe size={17} />
                  Operate with Browser
                </ButtonLink>
                <Button size="xl" variant="ghost" onClick={() => scrollToId("learn-more")}>
                  Learn more
                  <ArrowRight size={16} />
                </Button>
              </div>
            </Reveal>
            <Reveal delay={0.2}>
              <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs font-medium text-muted">
                <span className="inline-flex items-center gap-1.5">
                  <OsGlyph os="windows" size={14} /> Windows
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <OsGlyph os="mac" size={14} /> macOS
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <OsGlyph os="linux" size={14} /> Linux
                </span>
                <span className="text-muted/60">·</span>
                <span>Free to install</span>
              </div>
            </Reveal>
          </div>

          <Reveal delay={0.15} className="lg:pl-6">
            <HeroVisual />
          </Reveal>
        </Container>
      </header>

      {/* ── Stat strip ───────────────────────────────────────────────────── */}
      <div className="border-y border-border/70 bg-surface/40">
        <Container>
          <RevealGroup className="grid grid-cols-2 gap-6 py-10 md:grid-cols-4">
            {[
              ["Channels", "for every team & topic"],
              ["Real-time", "across web & desktop"],
              ["AES-256", "encryption at rest"],
              ["0 outsiders", "a fully closed network"],
            ].map(([big, small]) => (
              <RevealItem key={small} className="text-center">
                <p className="text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
                  <span className="text-gradient">{big}</span>
                </p>
                <p className="mt-1 text-sm text-muted">{small}</p>
              </RevealItem>
            ))}
          </RevealGroup>
        </Container>
      </div>

      {/* ── Features ─────────────────────────────────────────────────────── */}
      <Section id="learn-more">
        <Container>
          <Reveal>
            <SectionHeading
              eyebrow="Why BlissWork"
              title={<>Everything your team needs to <span className="text-gradient">talk in one place</span></>}
              lead="One calm surface for the conversation that runs your company — channels, direct messages, a single inbox, and the reminders that refuse to be forgotten."
            />
          </Reveal>
          <RevealGroup className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <RevealItem key={f.title}>
                <Card className="ring-glow group relative h-full overflow-hidden p-6">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent transition-transform duration-300 group-hover:-translate-y-0.5">
                    <f.icon size={20} />
                  </span>
                  <h3 className="mt-4 text-lg font-semibold tracking-tight text-fg">{f.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{f.desc}</p>
                </Card>
              </RevealItem>
            ))}
          </RevealGroup>
        </Container>
      </Section>

      {/* ── Closed-network spotlight ─────────────────────────────────────── */}
      <Section className="bg-surface/40">
        <Container className="grid items-center gap-14 lg:grid-cols-2">
          <Reveal className="order-2 lg:order-1">
            <div className="relative flex justify-center">
              <div className="dot-grid absolute inset-0 -z-10" aria-hidden />
              <Card className="w-full max-w-sm p-6 shadow-card">
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-2 text-sm font-semibold text-fg">
                    <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-from to-brand-to text-accent-fg">
                      <GlobeLock size={17} />
                    </span>
                    Your network
                  </span>
                  <Badge tone="success">Private</Badge>
                </div>
                <ul className="mt-5 space-y-1">
                  {NETWORK.map((p) => (
                    <li key={p.name} className="flex items-center gap-3 rounded-xl px-2 py-1.5">
                      <Avatar name={p.name} size="sm" />
                      <span className="text-sm text-fg">{p.name}</span>
                      <span
                        className={
                          "ml-auto h-2 w-2 rounded-full " +
                          (p.presence === "online" ? "bg-success" : "bg-muted/40")
                        }
                      />
                    </li>
                  ))}
                </ul>
                <p className="mt-4 border-t border-border/70 pt-4 text-center text-xs text-muted">
                  …and no one else. <span className="font-medium text-accent">Invite-only, always.</span>
                </p>
              </Card>
            </div>
          </Reveal>
          <div className="order-1 lg:order-2">
            <Reveal>
              <Eyebrow>The differentiator</Eyebrow>
              <h2 className="mt-5 text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
                Just you and <span className="text-gradient">your team</span>
              </h2>
              <p className="mt-4 text-base leading-relaxed text-muted sm:text-lg">
                Most chat apps connect you to the whole world and then ask you to mute it. BlissWork does the
                opposite: your workspace is a sealed network with exactly one population — the people you
                invited. No stranger can find you, message you, or even know you exist.
              </p>
              <ul className="mt-6 space-y-3">
                {[
                  "Every account on your network is someone you invited",
                  "No public profiles, no discovery, no DMs from outside",
                  "Per-org encryption and row-level isolation keep tenants sealed",
                ].map((t) => (
                  <li key={t} className="flex items-start gap-2.5 text-sm text-fg">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
                      <ShieldCheck size={12} />
                    </span>
                    {t}
                  </li>
                ))}
              </ul>
              <div className="mt-7">
                <Link to="/architect" className={button({ variant: "outline" })}>
                  See how we seal it
                  <ArrowRight size={16} />
                </Link>
              </div>
            </Reveal>
          </div>
        </Container>
      </Section>

      {/* ── Internal mail brag ───────────────────────────────────────────── */}
      <Section>
        <Container className="grid items-center gap-14 lg:grid-cols-2">
          <div>
            <Reveal>
              <Eyebrow>Internal mail</Eyebrow>
              <h2 className="mt-5 text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
                Mail that <span className="text-gradient">never leaves your network</span>
              </h2>
              <p className="mt-4 text-base leading-relaxed text-muted sm:text-lg">
                Chat is for the fast stuff. For announcements, decisions, and the on-the-record threads that
                deserve more than a message, BlissWork ships a complete internal mail system — addressed,
                composed, and threaded exactly like email, but sealed inside your organization. Internal mail
                never touches external SMTP and is never delivered outside your company — so there's no
                inbound spam and no external phishing, by construction rather than by a filter you hope works.
              </p>
              <ul className="mt-6 space-y-3">
                {[
                  "Compose, address, and thread just like the email you know",
                  "Every message stays encrypted at rest inside your private network",
                  "No external delivery — so no inbound spam, no external phishing",
                ].map((t) => (
                  <li key={t} className="flex items-start gap-2.5 text-sm text-fg">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
                      <Mail size={12} />
                    </span>
                    {t}
                  </li>
                ))}
              </ul>
              <div className="mt-7">
                <Link to="/userflow#mail" className={button({ variant: "outline" })}>
                  See internal mail
                  <ArrowRight size={16} />
                </Link>
              </div>
            </Reveal>
          </div>
          <Reveal className="lg:pl-6">
            <div className="relative flex justify-center">
              <div className="dot-grid absolute inset-0 -z-10" aria-hidden />
              <Card className="w-full max-w-sm p-6 shadow-card">
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-2 text-sm font-semibold text-fg">
                    <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-from to-brand-to text-accent-fg">
                      <Mail size={17} />
                    </span>
                    New mail
                  </span>
                  <Badge tone="accent">Internal only</Badge>
                </div>
                <div className="mt-5 space-y-2.5 text-sm">
                  <div className="flex items-center gap-3 border-b border-border/60 pb-2.5">
                    <span className="w-14 shrink-0 text-muted">To</span>
                    <span className="inline-flex items-center gap-1 rounded-md bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">
                      #all-hands
                    </span>
                  </div>
                  <div className="flex items-center gap-3 border-b border-border/60 pb-2.5">
                    <span className="w-14 shrink-0 text-muted">Subject</span>
                    <span className="truncate text-fg">Q3 all-hands — Thursday, 3pm</span>
                  </div>
                </div>
                <p className="mt-3 text-xs leading-relaxed text-muted">
                  Team — quick note ahead of Thursday. We'll cover the launch numbers, the roadmap, and a
                  few thank-yous. Deck attached…
                </p>
                <div className="mt-4 flex items-center justify-between border-t border-border/70 pt-3">
                  <span className="inline-flex items-center gap-1 text-[11px] text-muted">
                    <ShieldCheck size={13} className="text-success" /> Stays on your network
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-from to-brand-to px-3 py-1.5 text-xs font-medium text-accent-fg">
                    <Send size={13} /> Send
                  </span>
                </div>
              </Card>
            </div>
          </Reveal>
        </Container>
      </Section>

      {/* ── Sticky-note feature (demoted) ────────────────────────────────── */}
      <Section className="bg-surface/40">
        <Container className="grid items-center gap-14 lg:grid-cols-2">
          <div>
            <Reveal>
              <Eyebrow>A delightful extra</Eyebrow>
              <h2 className="mt-5 text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
                Even your tasks <span className="text-gradient">come to you</span>
              </h2>
              <p className="mt-4 text-base leading-relaxed text-muted sm:text-lg">
                Conversation is where work starts — but some things can't be allowed to scroll away. Turn any
                message into a task and it floats as a frameless, always-on-top sticky note on the assignee's
                desktop, surviving restarts, until it's acknowledged and done. The communication you'd expect,
                with a desktop touch nothing else has.
              </p>
              <ul className="mt-6 space-y-3">
                {[
                  "Auto-pins the moment a task is assigned to you",
                  "Collapse to a tiny pill, drag anywhere, never lose it",
                  "Each assignee has their own Acknowledge → Complete status",
                ].map((t) => (
                  <li key={t} className="flex items-start gap-2.5 text-sm text-fg">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
                      <Pin size={12} />
                    </span>
                    {t}
                  </li>
                ))}
              </ul>
              <div className="mt-7">
                <Link to="/userflow" className={button({ variant: "outline" })}>
                  See how it works
                  <ArrowRight size={16} />
                </Link>
              </div>
            </Reveal>
          </div>
          <Reveal className="lg:pl-6">
            <div className="relative flex justify-center">
              <div className="dot-grid absolute inset-0 -z-10" aria-hidden />
              <div className="flex flex-col gap-5 py-6">
                <StickyNote title="Sanity-check invite emails" from="Bob" className="rotate-[-3deg]" />
                <StickyNote title="Approve the new DEK rotation" from="Ashish" acknowledged className="ml-10 rotate-[2deg]" />
              </div>
            </div>
          </Reveal>
        </Container>
      </Section>

      {/* ── Security band ────────────────────────────────────────────────── */}
      <Section>
        <Container>
          <Reveal>
            <SectionHeading
              eyebrow="Secure by default"
              title={<>A network that's private <span className="text-gradient">all the way down</span></>}
              lead="The closed network is only the start. BlissWork was architected around a threat model — encryption, isolation, and verifiable history come standard, not as add-ons."
            />
          </Reveal>
          <RevealGroup className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {SECURITY.map((s) => (
              <RevealItem key={s.title}>
                <Card className="h-full p-6">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-brand-from to-brand-to text-accent-fg shadow-[0_8px_22px_-10px_var(--color-accent)]">
                    <s.icon size={20} />
                  </span>
                  <h3 className="mt-4 text-base font-semibold tracking-tight text-fg">{s.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{s.desc}</p>
                </Card>
              </RevealItem>
            ))}
          </RevealGroup>
          <Reveal delay={0.1}>
            <p className="mt-8 text-center text-sm text-muted">
              Curious about the engineering?{" "}
              <Link to="/architect" className="font-medium text-accent hover:underline">
                Explore the architecture →
              </Link>
            </p>
          </Reveal>
        </Container>
      </Section>

      {/* ── Cross-platform CTA ───────────────────────────────────────────── */}
      <Section className="pb-28">
        <Container>
          <Reveal>
            <div className="brand-mesh relative overflow-hidden rounded-3xl border border-border p-10 text-center shadow-card sm:p-16">
              <Eyebrow>One app, every desktop</Eyebrow>
              <h2 className="mx-auto mt-5 max-w-2xl text-balance text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
                Bring your whole team onto one private network
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-base text-muted">
                Native installers for Windows, macOS and Linux — the same calm, real-time experience
                everywhere.
              </p>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                <Button size="xl" onClick={getApp}>
                  <Download size={17} />
                  Get the App
                </Button>
                <ButtonLink
                  size="xl"
                  variant="secondary"
                  href={SITE.webApp}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Globe size={17} />
                  Operate with Browser
                </ButtonLink>
              </div>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-3 text-sm font-medium text-muted">
                {PLATFORM_ORDER.map((id) => (
                  <a
                    key={id}
                    href={PLATFORMS[id].primary.url}
                    download
                    title={`Download BlissWork for ${PLATFORMS[id].name} (${PLATFORMS[id].primary.ext})`}
                    className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-1.5 transition-colors hover:border-accent/50 hover:bg-accent-soft hover:text-accent"
                  >
                    <OsGlyph os={id} size={18} />
                    {PLATFORMS[id].name}
                  </a>
                ))}
              </div>
            </div>
          </Reveal>
        </Container>
      </Section>
    </>
  );
}

function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}
