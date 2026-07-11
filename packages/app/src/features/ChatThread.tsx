import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Send, MessageSquare, Ban } from "lucide-react";
import { Avatar, Button } from "@taskboard/ui";
import { clock, groupMessages } from "../lib/chatFormat";

export interface ThreadMessage {
  id: string;
  senderId: string;
  senderName?: string;
  body: string;
  at?: string;
  pending?: boolean;
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
}: {
  messages: ThreadMessage[];
  meId: string;
  onSend: (text: string) => void;
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
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Scroll the message list to the bottom on new messages. We scroll the
  // container DIRECTLY rather than calling endRef.scrollIntoView(): the latter
  // walks up and scrolls EVERY scrollable ancestor — including the
  // overflow-hidden app shell (still scrollable programmatically) — which
  // shoved the whole UI up and pushed the top navbar off-screen.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  const grow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  };

  const send = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
    requestAnimationFrame(() => taRef.current && (taRef.current.style.height = "auto"));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
            return (
              <div key={m.id}>
                {day && (
                  <div className="my-3 flex justify-center">
                    <span className="rounded-full bg-surface-2 px-3 py-0.5 text-[11px] font-medium text-muted">{day}</span>
                  </div>
                )}
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.16 }}
                  className={`flex items-end gap-2 ${mine ? "justify-end" : "justify-start"} ${grouped ? "mt-0.5" : "mt-2"}`}
                >
                  {!mine && showSenderNames && (
                    <div className="w-7 shrink-0">{!grouped && <Avatar name={m.senderName || "?"} size="sm" />}</div>
                  )}
                  <div className={`flex max-w-[72%] flex-col ${mine ? "items-end" : "items-start"}`}>
                    {!mine && showSenderNames && !grouped && (
                      <div className="mb-0.5 ml-1 text-xs font-medium text-muted">{m.senderName}</div>
                    )}
                    <div
                      className={`whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm shadow-[0_2px_10px_-4px_rgba(40,30,90,0.25)] ${
                        mine
                          ? "rounded-br-md bg-gradient-to-br from-brand-from to-brand-to text-accent-fg"
                          : "rounded-bl-md bg-surface text-fg ring-1 ring-border/60"
                      } ${m.pending ? "opacity-60" : ""}`}
                    >
                      {m.body}
                    </div>
                    <span className="mt-0.5 px-1 text-[10px] text-muted/70">
                      {m.pending ? "Sending…" : clock(m.at)}
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
        <form onSubmit={(e) => { e.preventDefault(); send(); }} className="flex items-end gap-2 border-t border-border/60 bg-surface/50 p-3 backdrop-blur">
          <textarea
            ref={taRef}
            rows={1}
            className="max-h-[140px] min-h-[44px] flex-1 resize-none rounded-2xl border border-border bg-surface px-4 py-2.5 text-sm leading-relaxed text-fg placeholder:text-muted/70 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
            placeholder={placeholder}
            value={text}
            onChange={(e) => { setText(e.target.value); grow(); onType?.(); }}
            onKeyDown={onKeyDown}
          />
          <Button type="submit" size="icon" disabled={!text.trim()} className="h-11 w-11 shrink-0 rounded-full" title="Send">
            <Send size={16} />
          </Button>
        </form>
      )}
    </div>
  );
}
