import { Link } from "react-router-dom";
import {
  Compass,
  Cpu,
  TrendingUp,
  ShieldCheck,
  LineChart,
  Heart,
  Sparkles,
  Lock,
  Gauge,
  ArrowRight,
  Download,
  type LucideProps,
} from "lucide-react";
import { type ComponentType } from "react";
import { Container, Section, Eyebrow, Button, button, Card, Avatar } from "@/components/ui";
import { Reveal, RevealGroup, RevealItem } from "@/components/Reveal";
import { PageHero } from "@/components/layout/PageHero";
import { useDownload } from "@/components/download/DownloadProvider";

interface Member {
  name: string;
  role: string;
  icon: ComponentType<LucideProps>;
  blurb: string;
}

const TEAM: Member[] = [
  {
    name: "Siddhant Shende",
    role: "Chief Executive Officer",
    icon: Compass,
    blurb:
      "Sets BlissWork's product vision and rallies the team around one belief: software should remove noise, not add to it. Siddhant keeps the company pointed at the people who actually use it.",
  },
  {
    name: "Arun Goyal",
    role: "Chief Technology Officer",
    icon: Cpu,
    blurb:
      "Owns the engineering soul of BlissWork — the microservice backbone, the real-time fabric, and the discipline of keeping every part small, observable, and fast.",
  },
  {
    name: "Nitish Goyal",
    role: "Business Lead & Practice Head",
    icon: TrendingUp,
    blurb:
      "Bridges what teams need with what BlissWork builds. Nitish leads go-to-market and the delivery practice, turning customer reality into a focused roadmap.",
  },
  {
    name: "Ashish Chauhan",
    role: "Chief Information Security Officer",
    icon: ShieldCheck,
    blurb:
      "Guards trust. Ashish drives BlissWork's security posture — encryption, isolation, audit, and compliance — so communication never comes at the cost of safety.",
  },
  {
    name: "Simanchala Shahu",
    role: "Chief Financial Officer",
    icon: LineChart,
    blurb:
      "Stewards the company's financial health and discipline, ensuring BlissWork grows sustainably and invests where it matters most — for customers and team alike.",
  },
];

const VALUES = [
  { icon: Heart, title: "Calm by default", desc: "Every decision is judged by whether it lowers a person's cognitive load. Quiet beats loud." },
  { icon: Lock, title: "Trust is the product", desc: "Security and privacy aren't features — they're the foundation everything else stands on." },
  { icon: Gauge, title: "Small, sharp, accountable", desc: "Tight services, tight files, clear ownership. We keep things legible so we can move fast." },
  { icon: Sparkles, title: "Built for real people", desc: "We design for the teammate at 4pm with twelve tabs open — not the demo on a clean screen." },
];

export default function About() {
  const { open } = useDownload();
  return (
    <>
      <PageHero
        eyebrow="About us"
        title={<>The team behind the <span className="text-gradient">calm</span></>}
        lead="BlissWork is built by people who were tired of tools that demand attention instead of earning it. We're a small, senior team obsessed with focus, trust, and giving every company a private place to talk."
      />

      {/* Mission */}
      <Section>
        <Container>
          <Card className="brand-mesh relative overflow-hidden p-10 text-center sm:p-16">
            <Reveal>
              <Eyebrow>Our mission</Eyebrow>
              <p className="mx-auto mt-6 max-w-3xl text-balance text-2xl font-semibold leading-snug tracking-tight text-fg sm:text-3xl">
                To give every team a private place to talk — channels, messages, and one inbox shared only
                with the people you work with, where nothing important is ever quietly forgotten.
              </p>
              <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-muted">
                We started BlissWork because enterprise communication had drifted away from the human using
                it — endless threads, strangers in your notifications, and work buried in noise. So we rebuilt
                it as a closed network: just you and your team, talking in channels and direct messages, with
                a single inbox that surfaces only what needs you — trustworthy enough for the most demanding
                teams.
              </p>
              <p className="mx-auto mt-6 max-w-2xl text-sm text-muted">
                BlissWork is a product by{" "}
                <span className="font-semibold text-fg">AEIV Global Private Limited</span>.
              </p>
            </Reveal>
          </Card>
        </Container>
      </Section>

      {/* Team */}
      <Section className="bg-surface/40">
        <Container>
          <Reveal>
            <div className="mb-12 text-center">
              <Eyebrow>Leadership</Eyebrow>
              <h2 className="mt-4 text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
                Meet the founders
              </h2>
              <p className="mx-auto mt-3 max-w-xl text-base text-muted">
                Five disciplines, one standard: build something we'd want to use every day.
              </p>
            </div>
          </Reveal>
          <RevealGroup className="mx-auto grid max-w-5xl gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {TEAM.map((m) => (
              <RevealItem key={m.name}>
                <Card className="ring-glow group relative flex h-full flex-col overflow-hidden p-6">
                  <div className="flex items-center gap-4">
                    <Avatar name={m.name} size="xl" />
                    <div className="min-w-0">
                      <h3 className="text-lg font-semibold tracking-tight text-fg">{m.name}</h3>
                      <p className="inline-flex items-center gap-1.5 text-sm font-medium text-accent">
                        <m.icon size={14} />
                        {m.role}
                      </p>
                    </div>
                  </div>
                  <p className="mt-4 text-sm leading-relaxed text-muted">{m.blurb}</p>
                </Card>
              </RevealItem>
            ))}
          </RevealGroup>
        </Container>
      </Section>

      {/* Values */}
      <Section>
        <Container>
          <Reveal>
            <div className="mb-12 text-center">
              <Eyebrow>What we believe</Eyebrow>
              <h2 className="mt-4 text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
                The principles we build by
              </h2>
            </div>
          </Reveal>
          <RevealGroup className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {VALUES.map((v) => (
              <RevealItem key={v.title}>
                <Card className="h-full p-6">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
                    <v.icon size={20} />
                  </span>
                  <h3 className="mt-4 text-base font-semibold tracking-tight text-fg">{v.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{v.desc}</p>
                </Card>
              </RevealItem>
            ))}
          </RevealGroup>
        </Container>
      </Section>

      {/* CTA */}
      <Section className="pb-28">
        <Container className="text-center">
          <Reveal>
            <h2 className="mx-auto max-w-xl text-balance text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
              Come build in flow with us
            </h2>
            <p className="mx-auto mt-4 max-w-lg text-base text-muted">
              Try BlissWork with your team and feel what a calmer communication network is like.
            </p>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
              <Button size="xl" onClick={open}>
                <Download size={17} />
                Get the App
              </Button>
              <Link to="/userflow" className={button({ size: "xl", variant: "secondary" })}>
                See it in action
                <ArrowRight size={16} />
              </Link>
            </div>
          </Reveal>
        </Container>
      </Section>
    </>
  );
}
