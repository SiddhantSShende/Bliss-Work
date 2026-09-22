import { useRef, useState } from "react";
import { Loader2, MapPin, Paperclip, Send, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@taskboard/ui";
import { prettySize, type MediaItem } from "../lib/chatEnvelope";
import { EmojiPickerButton } from "./EmojiPicker";

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
  placeholder,
  dragging = false,
  attachments = [],
  onRemoveAttachment,
  uploading = 0,
  replyPreview,
  onCancelReply,
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
  /** Shown above the box while a quote is pending, so the user can see what
   *  they are replying to without scrolling back to find it. */
  replyPreview?: { who?: string; text: string };
  onCancelReply?: () => void;
}) {
  const { t } = useTranslation("composer");
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
      {replyPreview && (
        <div className="flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2">
          <div className="min-w-0 flex-1 border-l-2 border-accent pl-2">
            <div className="text-[11px] font-medium text-accent">
              {t("replyingTo", { who: replyPreview.who ?? t("thisMessage") })}
            </div>
            <div className="line-clamp-2 break-words text-xs text-muted">{replyPreview.text}</div>
          </div>
          {onCancelReply && (
            <button
              type="button"
              onClick={onCancelReply}
              title={t("cancelReply")}
              aria-label={t("cancelReply")}
              className="shrink-0 rounded-lg p-1 text-muted hover:bg-surface hover:text-fg"
            >
              <X size={14} />
            </button>
          )}
        </div>
      )}

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
                  title={t("removeAttachment", { name: item.name })}
                  aria-label={t("removeAttachment", { name: item.name })}
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
              {t("preparingFiles", { count: uploading })}
            </span>
          )}
        </div>
      )}

      <div className="flex min-w-0 items-center gap-2">
        <div className="flex shrink-0 items-center gap-1">
          {onAttach && (
            <button
              type="button"
              onClick={onAttach}
              className="flex h-11 w-11 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg"
              title={t("attachTitle")}
              aria-label={t("attachAriaLabel")}
            >
              <Paperclip size={18} />
            </button>
          )}
          {onShareLocation && (
            <button
              type="button"
              onClick={onShareLocation}
              className="flex h-11 w-11 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg"
              title={t("shareLocation")}
              aria-label={t("shareLocation")}
            >
              <MapPin size={18} />
            </button>
          )}
          <EmojiPickerButton
            onPick={(emoji) => {
              // Appended rather than inserted at the caret: the textarea is
              // uncontrolled from the picker's side, and reaching into its
              // selection would couple the two for no gain anyone has asked for.
              setText((current) => current + emoji);
              requestAnimationFrame(() => {
                taRef.current?.focus();
                grow();
              });
            }}
          />
        </div>
      <textarea
        ref={taRef}
        rows={1}
        className="max-h-[140px] min-h-[44px] min-w-0 flex-1 resize-none rounded-2xl border border-border bg-surface px-4 py-2.5 text-sm leading-relaxed text-fg placeholder:text-muted/70 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
        placeholder={
          dragging
            ? t("placeholder.dropFiles")
            : hasAttachments
              ? t("placeholder.addMessageOrSend")
              : (placeholder ?? t("placeholder.default"))
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
        title={t("send")}
      >
        <Send size={16} />
      </Button>
      </div>
    </form>
  );
}
