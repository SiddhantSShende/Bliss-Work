import { useRef, useState } from "react";
import { Loader2, MapPin, Paperclip, Send, X } from "lucide-react";
import { Button } from "@taskboard/ui";
import { prettySize, type MediaItem } from "../lib/chatEnvelope";

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
  attachments = [],
  onRemoveAttachment,
  uploading = 0,
}: {
  /**
   * Called with the typed text, which may be EMPTY when the user is sending
   * attachments alone. Surfaces wire this to `useChatMedia.flushStaged`, which
   * emits the tray and then the text, skipping whichever is absent.
   */
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
  /** Uploaded-but-unsent attachments, shown as removable chips above the box. */
  attachments?: MediaItem[];
  onRemoveAttachment?: (id: string) => void;
  /** How many uploads are still in flight — renders a "preparing…" chip. */
  uploading?: number;
}) {
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  const grow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  };

  const hasAttachments = attachments.length > 0;

  const send = () => {
    const t = text.trim();
    // Attachments alone are a valid message; text alone is too; neither is not.
    if (!t && !hasAttachments) return;
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
      className={`flex flex-col gap-2 border-t p-3 backdrop-blur transition-colors ${
        dragging
          ? "border-accent bg-accent-soft/40 ring-2 ring-inset ring-accent/40"
          : "border-border/60 bg-surface/50"
      }`}
    >
      {/* The attachment tray. Files land here on pick/drop/paste and go nowhere
          until Send — previously any of those three sent immediately, so a photo
          dragged into the wrong window was already gone. */}
      {(hasAttachments || uploading > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {attachments.map((item) => (
            <span
              key={item.id}
              className="inline-flex max-w-[15rem] items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1 text-xs text-fg"
            >
              <Paperclip size={12} className="shrink-0 text-muted" />
              <span className="truncate">{item.name}</span>
              <span className="shrink-0 text-muted/80">{prettySize(item.size)}</span>
              {onRemoveAttachment && (
                <button
                  type="button"
                  onClick={() => onRemoveAttachment(item.id)}
                  title={`Remove ${item.name}`}
                  aria-label={`Remove ${item.name}`}
                  className="-mr-0.5 shrink-0 rounded p-0.5 text-muted hover:bg-surface-2 hover:text-danger"
                >
                  <X size={12} />
                </button>
              )}
            </span>
          ))}
          {uploading > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-border px-2 py-1 text-xs text-muted">
              <Loader2 size={12} className="animate-spin" />
              Preparing {uploading} file{uploading === 1 ? "" : "s"}…
            </span>
          )}
        </div>
      )}

      <div className="flex items-end gap-2">
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
        placeholder={
          dragging
            ? "Drop files to attach…"
            : hasAttachments
              ? "Add a message, or press Send…"
              : placeholder
        }
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
      <Button
        type="submit"
        size="icon"
        disabled={!text.trim() && !hasAttachments}
        className="h-11 w-11 shrink-0 rounded-full"
        title="Send"
      >
        <Send size={16} />
      </Button>
      </div>
    </form>
  );
}
