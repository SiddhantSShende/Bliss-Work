import { useRef, useState } from "react";
import { Paperclip, Send } from "lucide-react";
import { Button } from "@taskboard/ui";

/**
 * Shared message composer extracted from ChatThread. Used inside both
 * ThreadView (Inbox) and the legacy ChatThread. Composes plain text +
 * optional file attachment offers (📎 button).
 *
 * The attachment button is gated by `onAttach`; if absent it's hidden so the
 * web app doesn't show a button that can't deliver. In the desktop app
 * Phase 10's renderer wires the picker through MessageChannelMain.
 */
export function Composer({
  onSend,
  onAttach,
  placeholder = "Write a message…",
}: {
  onSend: (text: string) => void;
  onAttach?: () => void;
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

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

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); send(); }}
      className="flex items-end gap-2 border-t border-border/60 bg-surface/50 p-3 backdrop-blur"
    >
      {onAttach && (
        <button
          type="button"
          onClick={onAttach}
          className="h-11 w-11 shrink-0 rounded-full text-muted hover:bg-surface-2 hover:text-fg"
          title="Attach file (up to 10 GB, peer-to-peer)"
        >
          <Paperclip size={18} className="mx-auto" />
        </button>
      )}
      <textarea
        ref={taRef}
        rows={1}
        className="max-h-[140px] min-h-[44px] flex-1 resize-none rounded-2xl border border-border bg-surface px-4 py-2.5 text-sm leading-relaxed text-fg placeholder:text-muted/70 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
        placeholder={placeholder}
        value={text}
        onChange={(e) => { setText(e.target.value); grow(); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <Button type="submit" size="icon" disabled={!text.trim()} className="h-11 w-11 shrink-0 rounded-full" title="Send">
        <Send size={16} />
      </Button>
    </form>
  );
}
