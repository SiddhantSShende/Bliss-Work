import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { MessageSquare, Ban, Forward, PhoneMissed } from "lucide-react";
import { Avatar } from "@taskboard/ui";
import { clock, groupMessages } from "../lib/chatFormat";
import type { MessageDTO } from "@taskboard/shared";
import { isMediaMessage, type MediaItem } from "../lib/chatEnvelope";
import { Composer } from "./Composer";
import { SystemPill } from "./SystemPill";
import { MessageStatusBadge } from "./MessageStatusBadge";

export interface ThreadMessage {
  id: string;
  senderId: string;
  senderName?: string;
  body: string;
  at?: string;
  pending?: boolean;
  /** System entries (a missed call, a forward handed off to WhatsApp) render as
   *  a centered notice, not a bubble. */
  kind?: "text" | "call_missed" | "forward_external";
  /** Sender-side delivery state. Set only on the caller's own messages. */
  status?: MessageDTO["status"];
}

/** Presentational chat thread (bubbles + composer). Reused by DMs and channels. */
export function ChatThread({
  messages,
  meId,
  onSend,
  onType,
  peerTyping = false,
  peerName,
  showSenderNames = false,
  placeholder = "Write a message…",
  disabled = false,
  notice,
  onForward,
  renderBody,
  onAttach,
  onShareLocation,
  onPaste,
  dropzone,
  dragging = false,
  attachments,
  onRemoveAttachment,
  uploading,
  overlay,
}: {
  messages: ThreadMessage[];
  meId: string;
  onSend: (text: string) => void;
  /** When provided, each non-pending bubble shows a hover "Forward" action. */
  onForward?: (messageId: string) => void;
  /**
   * Escape hatch for structured bodies (attachments, shared locations). Return
   * null to fall through to the plain text bubble. Mirrors ThreadView's hook so
   * both surfaces render the same things.
   */
  renderBody?: (m: ThreadMessage) => React.ReactNode | null;
  /** Composer affordances — hidden when not supplied. */
  onAttach?: () => void;
  onShareLocation?: () => void;
  onPaste?: (e: React.ClipboardEvent) => void;
  /** Drag-and-drop handlers for the whole surface, from useChatMedia. */
  dropzone?: {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
  dragging?: boolean;
  /** Staged-attachment tray, straight from useChatMedia. */
  attachments?: MediaItem[];
  onRemoveAttachment?: (id: string) => void;
  uploading?: number;
  /** Portal-ish extras rendered alongside the thread (the lightbox). */
  overlay?: React.ReactNode;
  /** Called on every local keystroke (drives the typing indicator). */
  onType?: () => void;
  /** True while the peer is typing — renders the animated "…" bubble. */
  peerTyping?: boolean;
  peerName?: string;
  showSenderNames?: boolean;
  placeholder?: string;
  /** When true, the composer is replaced by a `notice` banner (e.g. blocked). */
  disabled?: boolean;
  /** Message shown in place of the composer when `disabled` (e.g. "You blocked
   *  this user"). */
  notice?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll the message list to the bottom on new messages. We scroll the
  // container DIRECTLY rather than calling endRef.scrollIntoView(): the latter
  // walks up and scrolls EVERY scrollable ancestor — including the
  // overflow-hidden app shell (still scrollable programmatically) — which
  // shoved the whole UI up and pushed the top navbar off-screen.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" {...dropzone}>
      <div ref={listRef} className="min-h-0 flex-1 space-y-1 overflow-auto p-5">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
              <MessageSquare size={24} />
            </div>
            <div className="text-sm">No messages yet — say hi 👋</div>
          </div>
        ) : (
          groupMessages(messages).map(({ msg: m, day, grouped }) => {
            // Guard on a truthy meId: if the session id is briefly missing,
            // never treat a message as "mine" (which would right-align the whole
            // thread). A received message must default to the left.
            const mine = !!meId && m.senderId === meId;
            const dayChip = day && (
              <div className="my-3 flex justify-center">
                <span className="rounded-full bg-surface-2 px-3 py-0.5 text-[11px] font-medium text-muted">{day}</span>
              </div>
            );

            // A missed call is a fact about the conversation, not something
            // either side said — centered, no bubble, no forward action. Both
            // members see the same row; only the caller is told "no answer".
            if (m.kind === "call_missed") {
              return (
                <div key={m.id}>
                  {dayChip}
                  <SystemPill icon={<PhoneMissed size={12} className="text-red-500" />} at={m.at}>
                    {mine ? `${m.body} · no answer` : m.body}
                  </SystemPill>
                </div>
              );
            }

            // Handing a message to WhatsApp is the same class of fact: it left
            // the workspace. The body is authored server-side. The peer's copy
            // carries the caveat, because at depth 1 the peer IS the original
            // author — the person entitled to know we cannot actually confirm
            // a deep-link send.
            if (m.kind === "forward_external") {
              return (
                <div key={m.id}>
                  {dayChip}
                  <SystemPill
                    icon={<Forward size={12} className="text-accent" />}
                    at={m.at}
                    title="BlissWork opened WhatsApp with the message prefilled. Whether it was sent isn't something we can observe."
                  >
                    {m.body}
                    {!mine && <span className="text-amber-500">· not confirmed</span>}
                  </SystemPill>
                </div>
              );
            }

            // Structured bodies (attachments, shared locations) render their
            // own bubble; anything else falls through to plain text.
            const custom = renderBody?.(m) ?? null;

            return (
              <div key={m.id}>
                {dayChip}
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.16 }}
                  className={`flex items-end gap-2 ${mine ? "justify-end" : "justify-start"} ${grouped ? "mt-0.5" : "mt-2"}`}
                >
                  {!mine && showSenderNames && (
                    <div className="w-7 shrink-0">{!grouped && <Avatar name={m.senderName || "?"} size="sm" />}</div>
                  )}
                  <div className={`flex ${custom ? "max-w-[85%]" : "max-w-[72%]"} flex-col ${mine ? "items-end" : "items-start"}`}>
                    {!mine && showSenderNames && !grouped && (
                      <div className="mb-0.5 ml-1 text-xs font-medium text-muted">{m.senderName}</div>
                    )}
                    <div className={`group flex items-center gap-1 ${mine ? "flex-row-reverse" : "flex-row"}`}>
                      {custom ? (
                        <div className={m.pending ? "opacity-60" : ""}>{custom}</div>
                      ) : (
                        <div
                          className={`whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm shadow-[0_2px_10px_-4px_rgba(40,30,90,0.25)] ${
                            mine
                              ? "rounded-br-md bg-gradient-to-br from-brand-from to-brand-to text-accent-fg"
                              : "rounded-bl-md bg-surface text-fg ring-1 ring-border/60"
                          } ${m.pending ? "opacity-60" : ""}`}
                        >
                          {m.body}
                        </div>
                      )}
                      {/* Forwarding clones the body verbatim, so a media message
                          would hand the recipient attachment ids scoped to a
                          conversation they aren't in — every download 403s into a
                          broken card. Hide the affordance rather than ship that.
                          Text and locations are self-contained and forward fine. */}
                      {onForward && !m.pending && !isMediaMessage(m.body) && (
                        <button
                          onClick={() => onForward(m.id)}
                          title="Forward"
                          aria-label="Forward message"
                          className="shrink-0 rounded-full p-1 text-muted opacity-0 transition-opacity hover:bg-surface-2 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
                        >
                          <Forward size={13} />
                        </button>
                      )}
                    </div>
                    <span className="mt-0.5 flex items-center gap-1 px-1 text-[10px] text-muted/70">
                      {m.pending ? "Sending…" : clock(m.at)}
                      {/* Sent → Delivered → Seen, on my own bubbles only. The
                          Inbox thread has shown this for a while; DMs and
                          channels never did, so there was no way to tell
                          whether a message had landed. */}
                      {mine && !m.pending && <MessageStatusBadge status={m.status} />}
                    </span>
                  </div>
                </motion.div>
              </div>
            );
          })
        )}
      </div>

      {peerTyping && (
        <div className="flex items-center gap-2 px-5 pb-1.5 text-xs text-muted">
          <span className="inline-flex items-end gap-1">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted/60 [animation-delay:-0.2s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted/60 [animation-delay:-0.1s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted/60" />
          </span>
          {peerName ? `${peerName} is typing…` : "Typing…"}
        </div>
      )}

      {disabled ? (
        <div className="flex items-center justify-center gap-2 border-t border-border/60 bg-surface-2/60 p-4 text-sm text-muted">
          <Ban size={15} className="shrink-0 text-danger" />
          <span>{notice ?? "You can't message this conversation."}</span>
        </div>
      ) : (
        <Composer
          onSend={onSend}
          onType={onType}
          onAttach={onAttach}
          onShareLocation={onShareLocation}
          onPaste={onPaste}
          placeholder={placeholder}
          dragging={dragging}
          attachments={attachments}
          onRemoveAttachment={onRemoveAttachment}
          uploading={uploading}
        />
      )}

      {overlay}
    </div>
  );
}
