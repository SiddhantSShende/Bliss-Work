import { Link } from "react-router-dom";
import {
  Building2,
  Mail,
  MailCheck,
  GlobeLock,
  Hash,
  Users,
  MessagesSquare,
  AtSign,
  Send,
  MessageSquare,
  EyeOff,
  Reply,
  Inbox,
  CheckCheck,
  ListPlus,
  Pin,
  ThumbsUp,
  Share2,
  ShieldCheck,
  FolderDown,
  ArrowRight,
  Download,
} from "lucide-react";
import { Container, Section, Eyebrow, Button, button, Card } from "@/components/ui";
import { Reveal } from "@/components/Reveal";
import { PageHero } from "@/components/layout/PageHero";
import { StepFlow, type FlowStep } from "@/components/diagram/StepFlow";
import { useDownload } from "@/components/download/DownloadProvider";

interface Journey {
  id: string;
  eyebrow: string;
  title: React.ReactNode;
  lead: string;
  steps: FlowStep[];
  note?: string;
}

const JOURNEYS: Journey[] = [
  {
    id: "onboarding",
    eyebrow: "Getting started",
    title: "Set up your private workspace",
    lead: "Create a workspace, invite the people you work with, and you've built a network that's yours alone — sealed to everyone else.",
    steps: [
      { icon: Building2, title: "Create your workspace", desc: "Spin up an organization with your name, email and a password. You're the admin of your own private network." },
      { icon: Mail, title: "Invite your team", desc: "Send email invites to teammates. Each invite is a secure, expiring link — the only way onto your network." },
      { icon: MailCheck, title: "They accept", desc: "Invitees set a password and join your workspace, channels, and directory." },
      { icon: GlobeLock, title: "Sealed to everyone else", desc: "That's the whole network: the people you invited, and no one else. No strangers, no discovery.", tone: "success" },
    ],
  },
  {
    id: "channels",
    eyebrow: "Communication",
    title: "Channels for the whole team",
    lead: "Give every project, squad, or topic a home — and keep the right people in the loop without anyone drowning in noise.",
    steps: [
      { icon: Hash, title: "Create a channel", desc: "Name it for a project or a team — #launch, #design, #product. It takes one click." },
      { icon: Users, title: "Add the right people", desc: "Pull in exactly who needs the context. Channels are visible only to their members." },
      { icon: MessagesSquare, title: "Talk in the open", desc: "Post updates, ask questions, and share decisions in real time — on web and desktop." },
      { icon: AtSign, title: "Mention to pull someone in", desc: "An @mention drops the message straight into that teammate's inbox.", tone: "success" },
    ],
  },
  {
    id: "messaging",
    eyebrow: "Direct messages",
    title: "Direct messages that protect your focus",
    lead: "For one-to-one conversations, BlissWork replaces the endless thread with a simple choice: reply, or let it go — for both of you.",
    steps: [
      { icon: Send, title: "Send a message", desc: "Write to a teammate. It arrives in real time, wherever they're signed in." },
      { icon: MessageSquare, title: "They see Reply or Ignore", desc: "No pressure to perform a read receipt — just two honest choices." },
      { icon: EyeOff, title: "Ignore clears it — for both", desc: "Choosing Ignore removes the conversation from both inboxes. Mutual, quiet, done.", tone: "danger" },
      { icon: Reply, title: "Reply keeps it alive", desc: "A reply continues the thread and revives anything that was previously ignored.", tone: "success" },
    ],
  },
  {
    id: "mail",
    eyebrow: "Internal mail",
    title: "Mail that never leaves your network",
    lead: "For the on-the-record messages chat isn't built for, BlissWork has a full internal mail system — sealed inside your organization, where outside spam and phishing simply can't reach.",
    steps: [
      { icon: Mail, title: "Compose like email", desc: "Write a proper message — subject, body, recipients — for the things that deserve more than a chat." },
      { icon: Users, title: "Address your team", desc: "Send to teammates or a whole channel. Every recipient lives inside your org — and only there." },
      { icon: ShieldCheck, title: "It never leaves the network", desc: "No external SMTP and no outside inboxes. Mail is encrypted and stays entirely in-house.", tone: "success" },
      { icon: Inbox, title: "Lands in their inbox", desc: "It arrives in the same calm inbox as everything else — threaded, searchable, and on the record." },
    ],
    note: "Because internal mail is never delivered outside your organization, there's no inbound spam and no external phishing — a boundary, not a filter.",
  },
  {
    id: "inbox",
    eyebrow: "Staying on top",
    title: "One inbox for everything that needs you",
    lead: "Mentions, replies, mail, and tasks all land in a single place — so 'what needs me?' has exactly one answer.",
    steps: [
      { icon: AtSign, title: "It collects what's yours", desc: "Channel mentions, direct replies, internal mail, and assigned tasks flow into one inbox automatically." },
      { icon: Inbox, title: "Only what needs you", desc: "If it isn't addressed to you, it isn't here. No feed to scroll, no FOMO." },
      { icon: Reply, title: "Act in a tap", desc: "Reply, jump to the channel, or acknowledge a task — right from the inbox.", tone: "success" },
      { icon: CheckCheck, title: "And it clears", desc: "Handle it and it leaves your inbox. Inbox zero that actually means zero.", tone: "success" },
    ],
  },
  {
    id: "tasks",
    eyebrow: "A delightful extra",
    title: "A task you can't forget",
    lead: "Not everything can live in the scroll. Promote a message to a task and it sticks to your desktop — literally — until it's finished.",
    steps: [
      { icon: ListPlus, title: "Create & assign", desc: "Write a task with a title and details, then assign it to one or more teammates." },
      { icon: Pin, title: "It auto-pins for them", desc: "The task appears as an always-on-top sticky note on each assignee's desktop." },
      { icon: ThumbsUp, title: "Acknowledge", desc: "Assignees acknowledge to commit — the sender is notified instantly.", tone: "success" },
      { icon: CheckCheck, title: "Complete", desc: "Marking it complete notifies the sender and quietly unpins the note.", tone: "success" },
    ],
    note: "Each assignee has their own independent status — assign one task to five people and track all five separately.",
  },
  {
    id: "files",
    eyebrow: "Sharing",
    title: "Send files, peer to peer",
    lead: "Large files move directly between teammates over an encrypted channel — verified on arrival, never stranded on a server.",
    steps: [
      { icon: Users, title: "Pick a teammate", desc: "Choose who to send to. BlissWork sets up a direct, secure connection." },
      { icon: Share2, title: "Stream directly", desc: "The file flows peer-to-peer over WebRTC — fast, private, and server-free." },
      { icon: ShieldCheck, title: "Verified on arrival", desc: "A streaming SHA-256 check confirms the file is byte-for-byte intact.", tone: "success" },
      { icon: FolderDown, title: "Saved & revealed", desc: "It lands in Downloads and pops open in your file manager. Done." },
    ],
  },
];

export default function Userflow() {
  const { open } = useDownload();
  return (
    <>
      <PageHero
        eyebrow="Userflow"
        title={<>How BlissWork <span className="text-gradient">works for you</span></>}
        lead="No jargon — just the everyday journeys your team will live in, from the first invite to the last completed task."
      />

      {/* big-idea primer */}
      <Section className="pb-6">
        <Container>
          <Card className="grid items-center gap-8 overflow-hidden p-8 sm:p-10 lg:grid-cols-[1.3fr_1fr]">
            <div>
              <Eyebrow>The big idea</Eyebrow>
              <h2 className="mt-4 text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
                A network of just your team
              </h2>
              <p className="mt-3 text-base leading-relaxed text-muted">
                Everyone on your BlissWork is someone you invited — there's no public directory to be found
                in, and no way for an outside account to reach you. Inside that sealed network you get
                channels, direct messages, internal mail, and a single inbox, shared only with your team.
                That's the whole philosophy in one idea.
              </p>
            </div>
            <div className="flex justify-center">
              <div className="relative flex flex-col items-center gap-3 rounded-2xl border border-border bg-surface px-8 py-7 shadow-card">
                <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-from to-brand-to text-accent-fg shadow-[0_8px_22px_-10px_var(--color-accent)]">
                  <GlobeLock size={30} />
                </span>
                <p className="text-sm font-semibold text-fg">Your private network</p>
                <p className="text-xs text-accent">Invite-only, always</p>
              </div>
            </div>
          </Card>
        </Container>
      </Section>

      {JOURNEYS.map((j, idx) => (
        <Section key={j.id} id={j.id} className={idx % 2 === 1 ? "bg-surface/40" : ""}>
          <Container>
            <Reveal>
              <div className="mb-10 max-w-2xl">
                <Eyebrow>{j.eyebrow}</Eyebrow>
                <h2 className="mt-4 text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
                  {j.title}
                </h2>
                <p className="mt-3 text-base leading-relaxed text-muted">{j.lead}</p>
              </div>
            </Reveal>
            <StepFlow steps={j.steps} />
            {j.note && (
              <Reveal delay={0.1}>
                <p className="mt-8 rounded-xl border border-border bg-accent-soft/40 px-4 py-3 text-sm text-fg">
                  <span className="font-semibold text-accent">Good to know — </span>
                  {j.note}
                </p>
              </Reveal>
            )}
          </Container>
        </Section>
      ))}

      {/* CTA */}
      <Section>
        <Container className="text-center">
          <Reveal>
            <h2 className="mx-auto max-w-xl text-balance text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
              Ready to feel the difference?
            </h2>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
              <Button size="xl" onClick={open}>
                <Download size={17} />
                Get the App
              </Button>
              <Link to="/architect" className={button({ size: "xl", variant: "secondary" })}>
                Under the hood
                <ArrowRight size={16} />
              </Link>
            </div>
          </Reveal>
        </Container>
      </Section>
    </>
  );
}
