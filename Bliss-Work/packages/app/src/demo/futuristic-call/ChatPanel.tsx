import { useState } from "react";
import { MoreVertical, Send } from "lucide-react";
import { Avatar, Button, cn } from "@taskboard/ui";
import type { ChatMessageDemo } from "./types";

export function ChatPanel({
  messages: initialMessages,
  className,
}: {
  messages: ChatMessageDemo[];
  className?: string;
}) {
  const [messages, setMessages] = useState(initialMessages);
  const [draft, setDraft] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setMessages((prev) => [...prev, { id: `local-${prev.length}`, from: "You", mine: true, at: Date.now(), text }]);
    setDraft("");
  };

  return (
    <aside className={cn("glass relative flex flex-col overflow-hidden rounded-2xl", className)} aria-label="Meeting chat">
      <header className="flex shrink-0 items-center justify-between border-b border-border/70 px-4 py-3">
        <span className="text-sm font-semibold tracking-wide text-fg">CHAT</span>
        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Chat options"
            aria-expanded={menuOpen}
            className="rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <MoreVertical size={16} />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-10 mt-1 w-32 overflow-hidden rounded-lg border border-border bg-surface shadow-card">
              <button
                type="button"
                onClick={() => {
                  setMessages([]);
                  setMenuOpen(false);
                }}
                className="block w-full px-3 py-2 text-left text-xs text-fg hover:bg-surface-2"
              >
                Clear chat
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.map((m) => (
          <div key={m.id} className={cn("flex items-end gap-2", m.mine && "flex-row-reverse")}>
            <Avatar name={m.mine ? "You" : m.from} size="sm" />
            <div className={cn("max-w-[75%] rounded-xl px-3 py-2", m.mine ? "bg-accent-soft" : "bg-surface-2")}>
              <div className="flex items-baseline justify-between gap-2 text-[11px] text-muted">
                <span className={cn("truncate font-medium", m.mine ? "text-fg" : "text-accent")}>
                  {m.mine ? "You" : m.from}
                </span>
                <span className="shrink-0 tabular-nums">
                  {new Date(m.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                </span>
              </div>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-fg">{m.text}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-border/70 p-3">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Type a message..."
          aria-label="Type a message"
          className="min-w-0 flex-1 rounded-full border border-border bg-surface-2 px-4 py-2.5 text-sm text-fg outline-none placeholder:text-muted/70 focus:border-accent"
        />
        <Button size="icon" className="h-10 w-10 shrink-0 rounded-full" onClick={send} disabled={!draft.trim()} title="Send">
          <Send size={16} />
        </Button>
      </div>
    </aside>
  );
}
