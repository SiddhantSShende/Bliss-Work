import { useEffect, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Mail, Paperclip, Reply, Trash2, Loader2, AlertCircle } from "lucide-react";
import { Avatar, Badge, Button } from "@taskboard/ui";
import type { MailRecipientDTO } from "@taskboard/shared";
import { toast } from "sonner";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { errorText } from "../lib/errorText";
import { useAttachmentLinks } from "../lib/useAttachmentLinks";
import { formatBytes } from "../features/MailAttachments";

/**
 * Main pane content for /app/inbox/mail/:mailId — one complete email.
 *
 * Renders in the SAME pane the list selects from, which is what makes the Inbox
 * read like a mail client rather than a list that navigates away. Nothing here
 * is truncated: the feed row carries a one-line preview and no body at all, so
 * this view is the only place the mail actually exists to the reader.
 */
export function MailDetail() {
  const { mailId } = useParams<{ mailId: string }>();
  if (!mailId) return null;
  return <MailDetailContent mailId={mailId} />;
}

function MailDetailContent({ mailId }: { mailId: string }) {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const nav = useNavigate();

  const q = useQuery({ queryKey: qk.mail(mailId), queryFn: () => api.mail(mailId) });
  const mail = q.data;

  // Mark read on open. Idempotent server-side (read_at is only stamped once),
  // so the feed's own mark-on-peer-open and this can both fire safely.
  useEffect(() => {
    if (!mail || mail.readAt) return;
    void api
      .readMail(mailId)
      .then(() => {
        void qc.invalidateQueries({ queryKey: qk.unifiedInbox });
        void qc.invalidateQueries({ queryKey: qk.inboxPeers });
        void qc.invalidateQueries({ queryKey: ["inboxPeerFeed"] });
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mailId, mail?.readAt]);

  const attachmentIds = useMemo(() => (mail?.attachments ?? []).map((a) => a.id), [mail]);
  const links = useAttachmentLinks(attachmentIds);

  const remove = useMutation({
    mutationFn: () => api.ignoreInboxItem("MAIL", mailId),
    onSuccess: () => {
      toast.success("Removed from your Inbox");
      void qc.invalidateQueries({ queryKey: qk.unifiedInbox });
      void qc.invalidateQueries({ queryKey: qk.inboxPeers });
      void qc.invalidateQueries({ queryKey: ["inboxPeerFeed"] });
      nav("/app/inbox/all", { replace: true });
    },
    onError: (e) => toast.error("Could not remove", { description: errorText(e) }),
  });

  if (q.isLoading) {
    return (
      <Centered>
        <Loader2 size={18} className="animate-spin text-accent" />
        <span>Loading mail…</span>
      </Centered>
    );
  }
  if (q.isError || !mail) {
    return (
      <Centered>
        <AlertCircle size={18} className="text-danger" />
        <span>This mail could not be opened. It may have been removed.</span>
        <Button size="sm" variant="ghost" onClick={() => void q.refetch()}>
          Try again
        </Button>
      </Centered>
    );
  }

  const senderLabel = mail.fromName || mail.fromAddress || "Unknown sender";
  const to = mail.recipients.filter((r) => r.kind === "TO");
  const cc = mail.recipients.filter((r) => r.kind === "CC");
  const bcc = mail.recipients.filter((r) => r.kind === "BCC");

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-fg">
              {mail.subject || "(no subject)"}
            </h2>
            {/* Which side of this mail the reader is on. The same row is
                somebody's Sent and somebody else's Inbox. */}
            <Badge tone={mail.folder === "SENT" ? "neutral" : "accent"}>
              {mail.folder === "SENT" ? "sent" : "inbox"}
            </Badge>
          </div>
          <div className="text-[11px] text-muted">{formatSentAt(mail.sentAt)}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={() =>
              nav("/app/inbox/compose", {
                state: {
                  to: mail.fromAddress ? [mail.fromAddress] : [],
                  subject: replySubject(mail.subject),
                  quoted: quoteBody(senderLabel, mail.sentAt, mail.bodyText),
                },
              })
            }
            title="Reply"
            aria-label="Reply"
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent-soft"
          >
            <Reply size={14} /> Reply
          </button>
          <button
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
            title="Remove from your Inbox — the sender's copy is unaffected"
            aria-label="Remove from your Inbox"
            className="rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-danger disabled:opacity-50"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
        <div className="flex items-start gap-3">
          {mail.fromUserId ? (
            <Avatar name={senderLabel} size="sm" />
          ) : (
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
              <Mail size={16} />
            </div>
          )}
          <div className="min-w-0 flex-1 text-xs">
            <div className="truncate text-sm font-medium text-fg">{senderLabel}</div>
            {mail.fromAddress && mail.fromAddress !== senderLabel && (
              <div className="truncate text-muted">{mail.fromAddress}</div>
            )}
            <AddressLine label="To" people={to} />
            <AddressLine label="Cc" people={cc} />
            {/* Server-filtered per viewer: the author sees the list they typed,
                everyone else sees only their own entry. So a Bcc shown here is
                never somebody else's. */}
            <AddressLine label="Bcc" people={bcc} />
          </div>
        </div>

        <div className="mt-4 whitespace-pre-wrap break-words text-sm leading-relaxed text-fg">
          {mail.bodyText || <span className="text-muted">(no message body)</span>}
        </div>

        {mail.attachments.length > 0 && (
          <div className="mt-6 border-t border-border/60 pt-4">
            <div className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-fg/80">
              <Paperclip size={14} /> {mail.attachments.length}{" "}
              {mail.attachments.length === 1 ? "attachment" : "attachments"}
            </div>
            <ul className="flex flex-col gap-1">
              {mail.attachments.map((a) => {
                const url = links.urlFor(a.id);
                return (
                  <li
                    key={a.id}
                    className="flex items-center gap-2 rounded-xl border border-border bg-surface px-2.5 py-2 text-xs"
                  >
                    <Paperclip size={14} className="shrink-0 text-muted" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-fg">{a.filename}</span>
                      <span className="block truncate text-muted">{formatBytes(a.sizeBytes)}</span>
                    </span>
                    {url ? (
                      <a
                        href={url}
                        download={a.filename}
                        className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 font-medium text-accent hover:bg-accent-soft"
                      >
                        <Download size={13} /> Download
                      </a>
                    ) : (
                      // Links are minted in one batched, short-lived request; a
                      // missing one means the mint is still in flight or access
                      // was denied, and neither is a broken download button.
                      <span className="shrink-0 text-muted">
                        {links.isLoading ? "Preparing…" : "Unavailable"}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function AddressLine({ label, people }: { label: string; people: MailRecipientDTO[] }) {
  if (people.length === 0) return null;
  return (
    <div className="truncate text-muted">
      <span className="text-muted/70">{label}: </span>
      {people.map((p) => p.displayName ?? p.address).join(", ")}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted">
      {children}
    </div>
  );
}

function formatSentAt(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "Re: x" — and not "Re: Re: x", which is what makes a thread's subject grow
 *  a prefix per reply in clients that skip this check. */
function replySubject(subject: string): string {
  const s = subject.trim();
  if (!s) return "Re:";
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/** The quoted original, in the plain-text convention every mail client renders. */
function quoteBody(sender: string, sentAt: string, body: string): string {
  const when = formatSentAt(sentAt);
  const quoted = body
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `\n\nOn ${when}, ${sender} wrote:\n${quoted}\n`;
}

