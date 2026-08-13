import { Link } from "react-router-dom";
import {
  ArrowRight,
  Download,
  Lock,
  KeyRound,
  Database,
  ScrollText,
  ShieldCheck,
  Network,
  Boxes,
  Radio,
} from "lucide-react";
import { Container, Section, Eyebrow, Button, button, Card, Badge } from "@/components/ui";
import { Reveal } from "@/components/Reveal";
import { PageHero } from "@/components/layout/PageHero";
import { FlowDiagram, type DiagNode, type DiagEdge, type NodeKind } from "@/components/diagram/FlowDiagram";
import { useDownload } from "@/components/download/DownloadProvider";

/* ── System map ───────────────────────────────────────────────────────────── */
const SYSTEM_NODES: DiagNode[] = [
  { id: "web", x: 255, y: 16, w: 190, h: 56, title: "Web app", subtitle: "React · browser", kind: "client" },
  { id: "desktop", x: 555, y: 16, w: 190, h: 56, title: "Desktop app", subtitle: "Electron · chat + sticky", kind: "client" },
  { id: "rest", x: 150, y: 132, w: 230, h: 56, title: "REST API", subtitle: "/api/v1 · per service", kind: "service" },
  { id: "ws", x: 470, y: 132, w: 210, h: 56, title: "ws-gateway", subtitle: "WebSocket fan-out", kind: "gateway" },
  { id: "redis", x: 770, y: 132, w: 170, h: 56, title: "Redis", subtitle: "presence · cache", kind: "infra" },
  { id: "auth", x: 40, y: 262, w: 180, h: 54, title: "auth-svc", subtitle: "orgs · JWKS", kind: "service" },
  { id: "task", x: 270, y: 262, w: 180, h: 54, title: "task-svc", subtitle: "tasks · sticky", kind: "service" },
  { id: "msg", x: 500, y: 262, w: 180, h: 54, title: "messaging-svc", subtitle: "channels · DMs", kind: "service" },
  { id: "notif", x: 730, y: 262, w: 210, h: 54, title: "notification-svc", subtitle: "inbox", kind: "service" },
  { id: "authdb", x: 55, y: 372, w: 150, h: 44, title: "authdb", kind: "db" },
  { id: "taskdb", x: 285, y: 372, w: 150, h: 44, title: "taskdb", kind: "db" },
  { id: "msgdb", x: 515, y: 372, w: 150, h: 44, title: "messagingdb", kind: "db" },
  { id: "notifdb", x: 760, y: 372, w: 150, h: 44, title: "notificationdb", kind: "db" },
  { id: "kafka", x: 55, y: 474, w: 590, h: 52, title: "Apache Kafka (KRaft)", subtitle: "transactional outbox → event bus", kind: "infra" },
  { id: "email", x: 700, y: 474, w: 210, h: 52, title: "email-worker", subtitle: "invites · SMTP", kind: "service" },
];

const SYSTEM_EDGES: DiagEdge[] = [
  { from: "web", to: "rest", color: "muted", label: "REST", fromSide: "bottom", toSide: "top" },
  { from: "desktop", to: "rest", color: "muted", fromSide: "bottom", toSide: "top" },
  { from: "web", to: "ws", color: "brand", flow: true, label: "WebSocket", fromSide: "bottom", toSide: "top" },
  { from: "desktop", to: "ws", color: "brand", flow: true, fromSide: "bottom", toSide: "top" },
  { from: "ws", to: "redis", color: "muted", fromSide: "right", toSide: "left" },
  { from: "rest", to: "auth", color: "muted", fromSide: "bottom", toSide: "top" },
  { from: "rest", to: "task", color: "muted", fromSide: "bottom", toSide: "top" },
  { from: "rest", to: "msg", color: "muted", fromSide: "bottom", toSide: "top" },
  { from: "auth", to: "authdb", color: "muted", fromSide: "bottom", toSide: "top" },
  { from: "task", to: "taskdb", color: "muted", fromSide: "bottom", toSide: "top" },
  { from: "msg", to: "msgdb", color: "muted", fromSide: "bottom", toSide: "top" },
  { from: "notif", to: "notifdb", color: "muted", fromSide: "bottom", toSide: "top" },
  { from: "task", to: "kafka", color: "accent", dashed: true, label: "publish", fromSide: "bottom", toSide: "top" },
  { from: "msg", to: "kafka", color: "accent", dashed: true, fromSide: "bottom", toSide: "top" },
  { from: "kafka", to: "ws", color: "accent", flow: true, label: "consume", fromSide: "top", toSide: "bottom" },
  { from: "kafka", to: "email", color: "accent", dashed: true, fromSide: "right", toSide: "left" },
  { from: "kafka", to: "notif", color: "accent", dashed: true, fromSide: "right", toSide: "bottom" },
];

/* ── Event flow ───────────────────────────────────────────────────────────── */
const EVENT_NODES: DiagNode[] = [
  { id: "write", x: 10, y: 60, w: 160, h: 80, title: "Service write", subtitle: "DB transaction", kind: "service" },
  { id: "outbox", x: 215, y: 60, w: 160, h: 80, title: "Outbox row", subtitle: "same txn", kind: "service" },
  { id: "poller", x: 420, y: 60, w: 150, h: 80, title: "Poller", subtitle: "at-least-once", kind: "service" },
  { id: "kafka", x: 615, y: 60, w: 150, h: 80, title: "Kafka", subtitle: "event bus", kind: "infra" },
  { id: "ws", x: 810, y: 60, w: 160, h: 80, title: "ws-gateway", subtitle: "recipientsOf()", kind: "gateway" },
  { id: "client", x: 1015, y: 60, w: 155, h: 80, title: "Client", subtitle: "live update", kind: "client" },
];
const EVENT_EDGES: DiagEdge[] = [
  { from: "write", to: "outbox", color: "accent", flow: true, label: "append", fromSide: "right", toSide: "left" },
  { from: "outbox", to: "poller", color: "accent", flow: true, fromSide: "right", toSide: "left" },
  { from: "poller", to: "kafka", color: "accent", flow: true, label: "publish", fromSide: "right", toSide: "left" },
  { from: "kafka", to: "ws", color: "accent", flow: true, label: "consume", fromSide: "right", toSide: "left" },
  { from: "ws", to: "client", color: "brand", flow: true, label: "push", fromSide: "right", toSide: "left" },
];

const LEGEND: { kind: NodeKind; label: string }[] = [
  { kind: "client", label: "Client" },
  { kind: "gateway", label: "Gateway" },
  { kind: "service", label: "Service" },
  { kind: "db", label: "Database" },
  { kind: "infra", label: "Infrastructure" },
];

const SECURITY_LAYERS = [
  { icon: KeyRound, title: "Identity — EdDSA / JWKS", desc: "auth-svc is the sole token issuer. Every service verifies signatures against cached public keys. No shared secrets, no HS256." },
  { icon: ShieldCheck, title: "Authorization — per-request org context", desc: "org and user are derived from the verified token, never trusted from a header. Spoofing is structurally impossible." },
  { icon: Database, title: "Isolation — Postgres Row-Level Security", desc: "Fail-closed RLS policies scope every query to one organization. Even a bug can't read another tenant's rows." },
  { icon: Lock, title: "Encryption — AES-256-GCM per-org DEK", desc: "Message and task content is encrypted at rest under a per-org data key, KMS-wrapped and crypto-shreddable for instant erasure." },
  { icon: ScrollText, title: "Auditability — hash-chained log", desc: "Each audit entry chains to the previous by hash, making the timeline tamper-evident and verifiable for compliance." },
];

const STACK = [
  "React 19", "Vite", "Electron", "TypeScript", "Tailwind CSS",
  "Python · FastAPI", "Go", "PostgreSQL 17", "Redis", "Apache Kafka",
  "WebSockets", "WebRTC", "Docker", "Kubernetes / Helm",
];

export default function Architect() {
  const { open } = useDownload();
  return (
    <>
      <PageHero
        eyebrow="Architecture"
        title={<>Engineered like <span className="text-gradient">infrastructure</span></>}
        lead="Under the calm surface is a real microservice platform: a closed, multi-tenant communication network with database-per-service isolation, an event-sourced backbone, and security designed around a threat model. Here's how channels, messages, internal mail, and your inbox actually move."
      />

      {/* System map */}
      <Section>
        <Container>
          <Reveal>
            <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div className="max-w-2xl">
                <Eyebrow>The system at a glance</Eyebrow>
                <h2 className="mt-4 text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
                  Six services, one calm experience
                </h2>
                <p className="mt-3 text-base leading-relaxed text-muted">
                  Web and desktop clients talk to focused services over REST and receive live updates —
                  channel posts, direct messages, and internal mail — through a WebSocket gateway. Each
                  domain service owns its own database — no shared tables, no hidden coupling — and every
                  query is scoped to your organization, so one network can never see another.
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                {LEGEND.map((l) => (
                  <LegendDot key={l.kind} kind={l.kind} label={l.label} />
                ))}
              </div>
            </div>
          </Reveal>
          <Reveal delay={0.05}>
            <Card className="p-4 sm:p-6">
              <div className="overflow-x-auto pb-2">
                <div className="min-w-[760px]">
                  <FlowDiagram nodes={SYSTEM_NODES} edges={SYSTEM_EDGES} width={1000} height={560} />
                </div>
              </div>
            </Card>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="mt-6 grid gap-4 sm:grid-cols-3">
              <MiniNote icon={Boxes} title="Database-per-service" body="authdb, taskdb, messagingdb, notificationdb — isolated, independently scalable." />
              <MiniNote icon={Network} title="Mesh-less by design" body="Clients derive identity from a signed token; services verify it locally. No central trust broker." />
              <MiniNote icon={Radio} title="Consume-all-and-filter" body="ws-gateway reads every event and delivers only what each connection may see — the right channel, the right inbox." />
            </div>
          </Reveal>
        </Container>
      </Section>

      {/* Event flow */}
      <Section className="bg-surface/40">
        <Container>
          <Reveal>
            <div className="mb-8 max-w-2xl">
              <Eyebrow>How an event travels</Eyebrow>
              <h2 className="mt-4 text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
                The transactional outbox, end to end
              </h2>
              <p className="mt-3 text-base leading-relaxed text-muted">
                A message and its event are committed in the <em>same</em> database transaction, so they can
                never disagree. A poller publishes to Kafka; the gateway fans the event out to exactly the
                right clients — the members of a channel, the recipient of a DM. Every event carries a UUIDv7
                id, so consumers dedupe and replay safely.
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.05}>
            <Card className="p-4 sm:p-6">
              <div className="overflow-x-auto pb-2">
                <div className="min-w-[820px]">
                  <FlowDiagram nodes={EVENT_NODES} edges={EVENT_EDGES} width={1180} height={200} />
                </div>
              </div>
            </Card>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="mt-6 flex flex-wrap gap-2">
              {["Exactly-once effects", "At-least-once delivery", "Idempotent consumers", "Replay on reconnect"].map((t) => (
                <Badge key={t} tone="accent">{t}</Badge>
              ))}
            </div>
          </Reveal>
        </Container>
      </Section>

      {/* Security layers */}
      <Section>
        <Container>
          <Reveal>
            <div className="mb-10 max-w-2xl">
              <Eyebrow>Defense in depth</Eyebrow>
              <h2 className="mt-4 text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
                Five layers between an attacker and your data
              </h2>
              <p className="mt-3 text-base leading-relaxed text-muted">
                Security isn't a feature bolted on at the end — it's the shape of the network. Your
                organization is a sealed tenant, and each layer holds even if the one above it fails.
              </p>
            </div>
          </Reveal>
          <ol className="relative mx-auto max-w-3xl space-y-3">
            {SECURITY_LAYERS.map((l, i) => (
              <Reveal key={l.title} delay={i * 0.06}>
                <li className="flex items-start gap-4 rounded-2xl border border-border bg-surface p-5 shadow-soft">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-from to-brand-to text-accent-fg shadow-[0_8px_22px_-10px_var(--color-accent)]">
                    <l.icon size={20} />
                  </span>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-bold tracking-wider text-muted">LAYER {i + 1}</span>
                    </div>
                    <h3 className="mt-0.5 text-base font-semibold tracking-tight text-fg">{l.title}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-muted">{l.desc}</p>
                  </div>
                </li>
              </Reveal>
            ))}
          </ol>
        </Container>
      </Section>

      {/* Tech stack */}
      <Section className="bg-surface/40">
        <Container className="text-center">
          <Reveal>
            <Eyebrow>Built on proven foundations</Eyebrow>
            <h2 className="mx-auto mt-4 max-w-xl text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
              A modern, open stack
            </h2>
          </Reveal>
          <Reveal delay={0.05}>
            <div className="mx-auto mt-8 flex max-w-3xl flex-wrap justify-center gap-2.5">
              {STACK.map((t) => (
                <span
                  key={t}
                  className="rounded-full border border-border bg-surface px-4 py-1.5 text-sm font-medium text-fg shadow-soft"
                >
                  {t}
                </span>
              ))}
            </div>
          </Reveal>
        </Container>
      </Section>

      {/* CTA */}
      <Section>
        <Container className="text-center">
          <Reveal>
            <h2 className="mx-auto max-w-xl text-balance text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
              Beautifully simple on the surface. Seriously engineered underneath.
            </h2>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
              <Button size="xl" onClick={open}>
                <Download size={17} />
                Get the App
              </Button>
              <Link to="/about" className={button({ size: "xl", variant: "secondary" })}>
                Meet the team
                <ArrowRight size={16} />
              </Link>
            </div>
          </Reveal>
        </Container>
      </Section>
    </>
  );
}

function LegendDot({ kind, label }: { kind: NodeKind; label: string }) {
  const color: Record<NodeKind, string> = {
    client: "var(--color-accent)",
    gateway: "var(--color-accent-strong)",
    service: "var(--color-border)",
    db: "var(--color-muted)",
    infra: "var(--color-muted)",
    accent: "var(--color-fg)",
  };
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted">
      <span
        className="h-3 w-3 rounded-[4px] border"
        style={{ background: "var(--color-surface)", borderColor: color[kind] }}
      />
      {label}
    </span>
  );
}

function MiniNote({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof Boxes;
  title: string;
  body: string;
}) {
  return (
    <Card className="p-5">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
        <Icon size={18} />
      </span>
      <h4 className="mt-3 text-sm font-semibold tracking-tight text-fg">{title}</h4>
      <p className="mt-1 text-sm leading-relaxed text-muted">{body}</p>
    </Card>
  );
}
