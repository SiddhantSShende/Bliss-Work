import { Link } from "react-router-dom";
import {
  Download,
  ArrowRight,
  Lock,
  ShieldCheck,
  KeyRound,
  Database,
  ScrollText,
  Trash2,
  Server,
  RefreshCw,
  Activity,
  Siren,
  Bug,
  type LucideProps,
} from "lucide-react";
import { type ComponentType } from "react";
import { Container, Section, Eyebrow, Button, button, Card } from "@/components/ui";
import { Reveal, RevealGroup, RevealItem } from "@/components/Reveal";
import { PageHero } from "@/components/layout/PageHero";
import { useDownload } from "@/components/download/DownloadProvider";

const SECURITY_EMAIL = "siddhant.shende@consultrnr.com";

interface Item {
  icon: ComponentType<LucideProps>;
  title: string;
  desc: string;
}

const CONTROLS: Item[] = [
  {
    icon: Lock,
    title: "Encryption at rest",
    desc: "Sensitive fields — email addresses, display names, and message content — are encrypted with AES-256-GCM, using keys scoped to each individual organisation.",
  },
  {
    icon: ShieldCheck,
    title: "Encryption in transit",
    desc: "All traffic between your devices and BlissWork is protected with TLS, and internal database connections require verified TLS certificates.",
  },
  {
    icon: KeyRound,
    title: "Argon2id passwords",
    desc: "Passwords are hashed with Argon2id and never stored in plaintext. We cannot see, recover, or reveal your password to anyone.",
  },
  {
    icon: Database,
    title: "Per-organisation isolation",
    desc: "Every organisation's data is isolated at the database level with row-level security, so one tenant can never reach another tenant's data.",
  },
  {
    icon: ScrollText,
    title: "Tamper-evident audit logs",
    desc: "Account and administrative actions are recorded in a hash-chained audit trail, so the history of who did what cannot be quietly rewritten.",
  },
  {
    icon: Trash2,
    title: "Crypto-shredding on deletion",
    desc: "Deleting an organisation destroys its encryption keys, rendering its data permanently unreadable — verifiable erasure, not just a hidden flag.",
  },
];

const OPERATIONS: Item[] = [
  {
    icon: Server,
    title: "Hardened infrastructure",
    desc: "BlissWork runs on access-controlled servers. Internal services talk to each other over authenticated channels, and access to production is limited and logged.",
  },
  {
    icon: RefreshCw,
    title: "Encrypted backups",
    desc: "Data is backed up regularly in encrypted form so your team's work survives hardware failure. Older backups are purged on a routine rotation cycle.",
  },
  {
    icon: Activity,
    title: "Availability & monitoring",
    desc: "We continuously monitor the health and performance of the platform and work to keep BlissWork available whenever your team needs it.",
  },
  {
    icon: Siren,
    title: "Incident response & breach notification",
    desc: "If we become aware of a security incident affecting personal data, we notify affected organisations, users, and the relevant authorities without undue delay, as required by the GDPR and India's DPDP Act, 2023.",
  },
];

function Grid({ items }: { items: Item[] }) {
  return (
    <RevealGroup className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((it) => (
        <RevealItem key={it.title}>
          <Card className="h-full p-6">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
              <it.icon size={20} />
            </span>
            <h3 className="mt-4 text-base font-semibold tracking-tight text-fg">{it.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">{it.desc}</p>
          </Card>
        </RevealItem>
      ))}
    </RevealGroup>
  );
}

export default function Security() {
  const { open } = useDownload();
  return (
    <>
      <PageHero
        eyebrow="Trust & Security"
        title={
          <>
            Security is the <span className="text-gradient">foundation</span>
          </>
        }
        lead="BlissWork is built so your team can talk freely and safely. Encryption, isolation, and verifiable deletion aren't add-ons — they're the base the product stands on."
      />

      {/* Core controls */}
      <Section>
        <Container>
          <Reveal>
            <div className="mb-12 text-center">
              <Eyebrow>How we protect your data</Eyebrow>
              <h2 className="mt-4 text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
                Protection built into every layer
              </h2>
              <p className="mx-auto mt-3 max-w-2xl text-base text-muted">
                From the database row to the network, your organisation's data is encrypted,
                isolated, and accountable by default.
              </p>
            </div>
          </Reveal>
          <Grid items={CONTROLS} />
        </Container>
      </Section>

      {/* Operations */}
      <Section className="bg-surface/40">
        <Container>
          <Reveal>
            <div className="mb-12 text-center">
              <Eyebrow>How we operate</Eyebrow>
              <h2 className="mt-4 text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
                Resilient, monitored, and ready
              </h2>
            </div>
          </Reveal>
          <div className="mx-auto max-w-4xl">
            <Grid items={OPERATIONS} />
          </div>
        </Container>
      </Section>

      {/* Responsible disclosure */}
      <Section>
        <Container className="max-w-4xl">
          <Reveal>
            <Card className="brand-mesh relative overflow-hidden p-8 sm:p-12">
              <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-soft text-accent">
                <Bug size={22} />
              </span>
              <h2 className="mt-5 text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
                Responsible disclosure
              </h2>
              <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted">
                We welcome reports from security researchers. If you believe you have found a
                vulnerability in BlissWork, please email us. We will acknowledge your report, work
                with you to resolve it, and we ask that you give us a reasonable opportunity to fix
                the issue before disclosing it publicly.
              </p>
              <div className="mt-7">
                <a
                  href={`mailto:${SECURITY_EMAIL}?subject=Security%20report`}
                  className={button({ size: "lg", variant: "primary" })}
                >
                  <Bug size={16} />
                  Report a vulnerability
                </a>
              </div>
              <p className="mt-4 text-sm text-muted">
                Or email{" "}
                <a
                  href={`mailto:${SECURITY_EMAIL}`}
                  className="font-medium text-accent underline decoration-accent/30 underline-offset-2 transition-colors hover:decoration-accent"
                >
                  {SECURITY_EMAIL}
                </a>
                .
              </p>
            </Card>
          </Reveal>
        </Container>
      </Section>

      {/* Compliance */}
      <Section className="pt-0">
        <Container className="max-w-4xl">
          <Reveal>
            <Card className="p-8 sm:p-10">
              <Eyebrow>Compliance & privacy</Eyebrow>
              <p className="mt-5 text-base leading-relaxed text-muted">
                BlissWork is operated by AEIV Global Private Limited, incorporated in India. We handle
                personal data in line with India's Digital Personal Data Protection Act, 2023, the EU
                and UK GDPR, and other applicable privacy laws — including honouring your rights to
                access, correct, and delete your data. Full details of what we collect and why are in
                our{" "}
                <Link
                  to="/privacy"
                  className="font-medium text-accent underline decoration-accent/30 underline-offset-2 transition-colors hover:decoration-accent"
                >
                  Privacy Policy
                </Link>
                .
              </p>
            </Card>
          </Reveal>
        </Container>
      </Section>

      {/* CTA */}
      <Section className="pb-28 pt-0">
        <Container className="text-center">
          <Reveal>
            <h2 className="mx-auto max-w-xl text-balance text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
              A workspace your team can trust
            </h2>
            <p className="mx-auto mt-4 max-w-lg text-base text-muted">
              Private by design, encrypted by default. Bring BlissWork to your team.
            </p>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
              <Button size="xl" onClick={open}>
                <Download size={17} />
                Get the App
              </Button>
              <Link to="/privacy" className={button({ size: "xl", variant: "secondary" })}>
                Read the Privacy Policy
                <ArrowRight size={16} />
              </Link>
            </div>
          </Reveal>
        </Container>
      </Section>
    </>
  );
}
