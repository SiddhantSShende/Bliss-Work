import { useRef, useState } from "react";
import { MapPin, Paperclip, Send } from "lucide-react";
import { Button } from "@taskboard/ui";

/**
 * Shared message composer. Used by ThreadView (Inbox), DMs and channels.
 *
 * Attachment and location affordances are gated by their callbacks so a surface
 * that cannot deliver them never shows a button that does nothing.
 */
export function Composer({
  onSend,
  onAttach,
  onShareLocation,
  onPaste,
  onType,
  placeholder = "Write a message…",
  dragging = false,
}: {
  onSend: (text: string) => void;
  onAttach?: () => void;
  onShareLocation?: () => void;
  /** Paste-to-upload: clipboard images become attachments. */
  onPaste?: (e: React.ClipboardEvent) => void;
  /** Called on every local keystroke (drives the typing indicator). */
  onType?: () => void;
  placeholder?: string;
  /** True while a file is being dragged over the surface — highlights the drop target. */
  dragging?: boolean;
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
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
      className={`flex items-end gap-2 border-t p-3 backdrop-blur transition-colors ${
        dragging
          ? "border-accent bg-accent-soft/40 ring-2 ring-inset ring-accent/40"
          : "border-border/60 bg-surface/50"
      }`}
    >
      {onAttach && (
        <button
          type="button"
          onClick={onAttach}
          className="h-11 w-11 shrink-0 rounded-full text-muted hover:bg-surface-2 hover:text-fg"
          title="Attach photos, videos or files"
          aria-label="Attach a file"
        >
          <Paperclip size={18} className="mx-auto" />
        </button>
      )}
      {onShareLocation && (
        <button
          type="button"
          onClick={onShareLocation}
          className="h-11 w-11 shrink-0 rounded-full text-muted hover:bg-surface-2 hover:text-fg"
          title="Share your location"
          aria-label="Share your location"
        >
          <MapPin size={18} className="mx-auto" />
        </button>
      )}
      <textarea
        ref={taRef}
        rows={1}
        className="max-h-[140px] min-h-[44px] flex-1 resize-none rounded-2xl border border-border bg-surface px-4 py-2.5 text-sm leading-relaxed text-fg placeholder:text-muted/70 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
        placeholder={dragging ? "Drop files to send…" : placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          grow();
          onType?.();
        }}
        onPaste={onPaste}
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
