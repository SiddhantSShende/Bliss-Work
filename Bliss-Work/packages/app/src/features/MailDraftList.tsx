import { NavLink } from "react-router-dom";
import { motion } from "framer-motion";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileEdit, Loader2, Paperclip, Trash2 } from "lucide-react";
import { EmptyState } from "@taskboard/ui";
import type { MailDraftDTO } from "@taskboard/shared";
import { toast } from "sonner";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { errorText } from "../lib/errorText";
import { listTime, splitMailPreview } from "../lib/mailView";

/**
 * The Drafts folder's message column.
 *
 * Its own component, and its own request, because a draft is the one thing in
 * the mailbox that is NOT in the unified feed: it has no counterparty, no
 * unread state and no delivery, so there is no inbox row for it to be a page of
 * (see lib/mailView). Everything else about the column — the header above it
 * with New Mail and the folder name — belongs to MailList and is shared.
 *
 * A row opens the composer on the draft rather than a reading pane. That is the
 * whole point of the folder: an unsent mail is something you go back to
 * writing, not something you go back to reading.
 */
export function MailDraftList({ search }: { search: string }) {
  const { api } = useRuntime();
  const qc = useQueryClient();

  const q = useQuery({ queryKey: qk.mailDrafts, queryFn: () => api.mailDrafts() });
  const drafts = q.data ?? [];

  const discard = useMutation({
    mutationFn: (mailId: string) => api.discardMailDraft(mailId),
    onSuccess: () => {
      toast.success("Draft discarded");
      void qc.invalidateQueries({ queryKey: qk.mailDrafts });
    },
    onError: (e) => toast.error("Could not discard", { description: errorText(e) }),
  });

  if (q.isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted">
        <Loader2 size={14} className="animate-spin text-accent" /> Loading drafts…
      </div>
    );
  }
  if (q.isError) {
    return (
      <EmptyState
        icon={<FileEdit size={22} />}
        title="Drafts could not be loaded"
        hint="Check your connection and choose Check for new mail above."
      />
    );
  }
  if (drafts.length === 0) {
    return (
      <EmptyState
        icon={<FileEdit size={22} />}
        title="No drafts"
        hint="A mail you start and leave without sending is kept here until you finish it."
      />
    );
  }

  return (
    <div className="pt-1">
      {drafts.map((d) => (
        <DraftRow
          key={d.mailId}
          draft={d}
          search={search}
          onDiscard={() => discard.mutate(d.mailId)}
        />
      ))}
    </div>
  );
}

/**
 * One unsent mail.
 *
 * Laid out like the sent rows beside it — who it is for, when it last moved,
 * what it is about — with two differences that matter: the person line names
 * the ADDRESSEE rather than a counterparty (a draft has no sender to show; the
 * sender is the reader), and an unaddressed draft says so instead of leaving
 * the line blank.
 */
function DraftRow({
  draft,
  search,
  onDiscard,
}: {
  draft: MailDraftDTO;
  search: string;
  onDiscard: () => void;
}) {
  const { subject, snippet } = splitMailPreview(draft.preview);
  const addressed =
    draft.to.length === 0
      ? "No recipient yet"
      : draft.to.length === 1
        ? draft.to[0]
        : `${draft.to[0]} + ${draft.to.length - 1} more`;

  return (
    <NavLink
      to={{ pathname: `/app/mail/compose/${draft.mailId}`, search }}
      className={({ isActive }) =>
        `group relative block rounded-xl px-3 py-3 transition-colors ${
          isActive
            ? "bg-accent-soft ring-1 ring-accent/20"
            : "after:absolute after:inset-x-3 after:bottom-0 after:h-px after:bg-border/45 after:transition-opacity hover:bg-surface-2/70 hover:after:opacity-0"
        }`
      }
    >
      <motion.div
        layout
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.14 }}
        className="flex items-start gap-3"
      >
        {/* Where the feed rows put the unread dot. Kept empty so the drafts
            column lines up with every other folder rather than sitting 8px to
            the left of them. */}
        <span aria-hidden className="mt-3.5 h-2 w-2 shrink-0" />
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
          <FileEdit size={16} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span
              className={`truncate text-sm font-medium ${
                draft.to.length === 0 ? "italic text-muted" : "text-fg/90"
              }`}
              title={draft.to.join(", ")}
            >
              {addressed}
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-muted">
              {listTime(draft.updatedAt)}
            </span>
          </div>

          <div className="mt-0.5 truncate text-[13px] text-fg/80">{subject || "(no subject)"}</div>
          {snippet && <div className="mt-0.5 truncate text-xs text-muted">{snippet}</div>}

          {draft.attachmentCount > 0 && (
            <div className="mt-1.5 inline-flex items-center gap-1 text-[10px] text-muted/80">
              <Paperclip size={10} />
              {draft.attachmentCount} {draft.attachmentCount === 1 ? "file" : "files"}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
          <button
            onClick={(e) => {
              // The row is a link; the button inside it is not a navigation.
              e.preventDefault();
              onDiscard();
            }}
            title="Discard this draft — it has not been sent to anyone"
            aria-label="Discard draft"
            className="inline-flex items-center gap-1 rounded-lg p-1.5 text-[11px] font-medium text-muted transition-colors hover:bg-surface hover:text-danger"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </motion.div>
    </NavLink>
  );
}
