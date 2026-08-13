import { motion, useReducedMotion } from "framer-motion";
import { Check, Hash, Pin, Plus, AtSign, Send } from "lucide-react";
import { cn } from "@/lib/cn";

/** Brand-gradient initials chip used for people throughout the mockup. */
function Initials({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-from to-brand-to font-semibold text-accent-fg",
        className,
      )}
    >
      {name.split(" ").map((w) => w[0]).join("").slice(0, 2)}
    </span>
  );
}

/**
 * Faux BlissWork app window: a calm team chat surface — a channels + DMs
 * sidebar on the left, an open channel conversation on the right.
 */
export function AppWindow({ className }: { className?: string }) {
  const channels = [
    { name: "general", active: false, unread: false },
    { name: "product", active: true, unread: false },
    { name: "design", active: false, unread: true },
    { name: "launch", active: false, unread: false },
  ];
  const dms = [
    { name: "Alice Reed", presence: "online" as const },
    { name: "Bob Lane", presence: "online" as const },
    { name: "Carol Vance", presence: "away" as const },
  ];

  return (
    <div className={cn("overflow-hidden rounded-2xl border border-border bg-surface shadow-card", className)}>
      {/* titlebar */}
      <div className="flex items-center gap-2 border-b border-border/70 bg-surface-2/60 px-4 py-2.5">
        <span className="h-3 w-3 rounded-full bg-danger/70" />
        <span className="h-3 w-3 rounded-full bg-warning/70" />
        <span className="h-3 w-3 rounded-full bg-success/70" />
        <span className="ml-3 inline-flex items-center gap-1 text-[11px] font-medium text-muted">
          BlissWork <span className="text-muted/50">—</span> <Hash size={11} /> product
        </span>
      </div>

      <div className="flex">
        {/* sidebar — channels + direct messages */}
        <div className="hidden w-44 shrink-0 flex-col gap-3 border-r border-border/70 p-3 sm:flex">
          <div className="flex flex-col gap-0.5">
            <p className="px-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-muted/60">Channels</p>
            {channels.map((c) => (
              <div
                key={c.name}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs",
                  c.active ? "bg-accent-soft font-semibold text-accent" : "text-muted",
                )}
              >
                <Hash size={12} className="shrink-0 opacity-70" />
                <span className="truncate">{c.name}</span>
                {c.unread && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-accent" />}
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-0.5">
            <p className="px-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-muted/60">
              Direct messages
            </p>
            {dms.map((p) => (
              <div key={p.name} className="flex items-center gap-2 rounded-lg px-2 py-1.5">
                <Initials name={p.name} className="h-6 w-6 text-[9px]" />
                <span className="truncate text-xs text-fg">{p.name.split(" ")[0]}</span>
                <span
                  className={cn(
                    "ml-auto h-1.5 w-1.5 rounded-full",
                    p.presence === "online" ? "bg-success" : "bg-muted/40",
                  )}
                />
              </div>
            ))}
          </div>
        </div>

        {/* main — open channel conversation */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* channel header */}
          <div className="flex items-center justify-between border-b border-border/70 px-4 py-2.5">
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-fg">
              <Hash size={14} className="text-muted" /> product
            </span>
            <span className="text-[10px] text-muted">12 members</span>
          </div>

          {/* messages */}
          <div className="flex-1 space-y-3.5 p-4">
            <ChatMessage
              name="Alice Reed"
              time="9:24"
              text="Pushed the new onboarding flow — ready for a look whenever."
            />
            <ChatMessage
              name="Bob Lane"
              time="9:26"
              text={
                <>
                  Looks clean. <span className="font-medium text-accent">@you</span> can you sanity-check the
                  invite emails before we ship?
                </>
              }
              mention
            />
            <ChatMessage name="Carol Vance" time="9:31" text="On it — pinning as a task so it doesn't slip." />
          </div>

          {/* composer */}
          <div className="border-t border-border/70 p-3">
            <div className="flex items-center gap-2 rounded-xl border border-border bg-surface-2/50 px-3 py-2">
              <Plus size={14} className="text-muted" />
              <span className="flex-1 truncate text-[11px] text-muted">Message #product</span>
              <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-gradient-to-br from-brand-from to-brand-to text-accent-fg">
                <Send size={12} />
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChatMessage({
  name,
  time,
  text,
  mention = false,
}: {
  name: string;
  time: string;
  text: React.ReactNode;
  mention?: boolean;
}) {
  return (
    <div className="flex gap-2.5">
      <Initials name={name} className="mt-0.5 h-7 w-7 text-[9px]" />
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-semibold text-fg">{name.split(" ")[0]}</span>
          <span className="text-[10px] text-muted/70">{time}</span>
        </div>
        <p
          className={cn(
            "mt-0.5 text-[11px] leading-relaxed text-muted",
            mention && "rounded-md bg-accent-soft/50 px-1.5 py-0.5 text-fg",
          )}
        >
          {text}
        </p>
      </div>
    </div>
  );
}

/** A small "mentioned you" toast — the inbox surfacing what needs you. */
export function InboxToast({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex w-60 items-center gap-3 rounded-2xl border border-accent/30 bg-surface p-3 shadow-widget ring-1 ring-accent/10",
        className,
      )}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-from to-brand-to text-accent-fg">
        <AtSign size={16} />
      </span>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold text-fg">Bob mentioned you</p>
        <p className="truncate text-[10px] text-muted">
          in <span className="text-accent">#product</span> · now in your inbox
        </p>
      </div>
    </div>
  );
}

/** A frameless always-on-top sticky-note widget (the desktop tasks feature). */
export function StickyNote({
  title = "Ship the launch demo",
  from = "Alice",
  className,
  acknowledged = false,
}: {
  title?: string;
  from?: string;
  className?: string;
  acknowledged?: boolean;
}) {
  return (
    <div
      className={cn(
        "w-60 rounded-2xl border border-accent/30 bg-surface p-3.5 shadow-widget ring-1 ring-accent/10",
        className,
      )}
    >
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-accent">
          <Pin size={11} /> Pinned task
        </span>
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-gradient-to-br from-brand-from to-brand-to text-[8px] font-semibold text-accent-fg">
          {from[0]}
        </span>
      </div>
      <p className="mt-2 text-sm font-semibold leading-snug text-fg">{title}</p>
      <p className="text-[11px] text-muted">from {from}</p>
      <div className="mt-3 flex gap-1.5">
        {acknowledged ? (
          <span className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-gradient-to-br from-brand-from to-brand-to px-2 py-1.5 text-[11px] font-medium text-accent-fg">
            <Check size={12} /> Complete
          </span>
        ) : (
          <>
            <span className="flex-1 rounded-lg bg-gradient-to-br from-brand-from to-brand-to px-2 py-1.5 text-center text-[11px] font-medium text-accent-fg">
              Acknowledge
            </span>
            <span className="rounded-lg border border-border px-2 py-1.5 text-center text-[11px] font-medium text-muted">
              Snooze
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Hero composition: the team-chat window as the centerpiece, with the inbox
 * toast and a sticky-note task gently floating to hint at the wider product.
 */
export function HeroVisual({ className }: { className?: string }) {
  const reduce = useReducedMotion();
  const float = (delay: number) =>
    reduce ? {} : { animate: { y: [0, -10, 0] }, transition: { duration: 6, repeat: Infinity, ease: "easeInOut", delay } };

  return (
    <div className={cn("relative", className)} aria-hidden>
      <motion.div
        initial={{ opacity: 0, y: 24, rotate: -1 }}
        animate={{ opacity: 1, y: 0, rotate: 0 }}
        transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
      >
        <AppWindow />
      </motion.div>

      {/* Floating accents only appear at lg, where the 2-column hero has room —
          below lg they'd crowd and clip the chat window. The inbox toast (the
          communication headline) leads; the sticky note is the quieter accent. */}
      <motion.div className="absolute -right-10 -top-7 hidden lg:block" {...float(0)}>
        <InboxToast />
      </motion.div>
      <motion.div className="absolute -bottom-9 -left-12 hidden lg:block" {...float(1.2)}>
        <StickyNote title="Sanity-check invite emails" from="Bob" />
      </motion.div>
    </div>
  );
}
