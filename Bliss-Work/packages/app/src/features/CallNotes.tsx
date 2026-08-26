/**
 * The notes panel: what the room decided, written down while it is being said.
 *
 * Beside the call, never instead of it — the panel takes a column, the tiles
 * keep the rest, and nobody leaves the meeting to write something down.
 *
 * Points are shared with everyone in the room as they are written (see
 * lib/roomMessages) and held only by the people who were there, so exporting is
 * an ordinary part of the flow rather than a power feature: the file is the
 * only copy that outlives the call.
 */
import { useEffect, useRef, useState } from "react";
import { Download, NotebookPen, Send, X } from "lucide-react";
import { Button } from "@taskboard/ui";
import { NOTE_TEXT_MAX, type NoteEntry } from "../lib/callNotes";

export function CallNotes({
  notes,
  onAdd,
  onExport,
  onClose,
}: {
  notes: NoteEntry[];
  onAdd: (text: string) => void;
  onExport: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  // Follow the tail. A point written by somebody else while you are reading
  // should arrive in view, not below the fold.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [notes.length]);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    onAdd(text.slice(0, NOTE_TEXT_MAX));
    setDraft("");
  };

  return (
    <aside
      aria-label="Meeting notes"
      className="glass flex h-full w-full flex-col overflow-hidden rounded-2xl"
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <NotebookPen size={15} className="shrink-0 text-accent" />
          <span className="truncate text-sm font-semibold text-fg">Notes</span>
          <span className="text-xs text-muted">{notes.length}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onExport}
            title="Save notes as a file"
            aria-label="Save notes as a file"
            className="rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <Download size={15} />
          </button>
          <button
            type="button"
            onClick={onClose}
            title="Close notes"
            aria-label="Close notes"
            className="rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <X size={15} />
          </button>
        </div>
      </header>

      {/* The one part of this room that scrolls, and it has to: a meeting can
          produce more points than fit, and dropping the older ones is the wrong
          answer for the thing people came here to keep. */}
      <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {notes.length === 0 ? (
          <p className="pt-6 text-center text-xs text-muted">
            No points yet. Anything written here is shared with everyone in the meeting.
          </p>
        ) : (
          notes.map((n) => (
            <div key={n.id} className="rounded-xl bg-surface-2 px-3 py-2">
              <div className="flex items-baseline justify-between gap-2 text-[11px] text-muted">
                <span className="truncate font-medium text-fg">{n.author}</span>
                <span className="shrink-0 tabular-nums">
                  {new Date(n.at).toLocaleTimeString(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
              </div>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-fg">{n.text}</p>
            </div>
          ))
        )}
      </div>

      <div className="shrink-0 border-t border-border/70 p-3">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter is a new line — the same rule as the
            // chat composer, because it is the same gesture.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          maxLength={NOTE_TEXT_MAX}
          rows={2}
          placeholder="Write an important point…"
          aria-label="Write an important point"
          className="w-full resize-none rounded-xl border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none placeholder:text-muted/70 focus:border-accent"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted">Enter to add</span>
          <Button size="sm" onClick={submit} disabled={!draft.trim()}>
            <Send size={13} /> Add point
          </Button>
        </div>
      </div>
    </aside>
  );
}
