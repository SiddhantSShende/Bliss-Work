import { useEffect } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Forward,
  Mail,
  Reply,
  ReplyAll,
  Trash2,
  Undo2,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { Avatar, Badge, Button } from "@taskboard/ui";
import type { MailDTO, MailRecipientDTO } from "@taskboard/shared";
import { toast } from "sonner";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { errorText } from "../lib/errorText";
import { clock, dayLabel } from "../lib/chatFormat";
import { mailSearch, folderOf, peerOf } from "../lib/mailView";
import {
  allRecipients,
  forwardBody,
  forwardSubject,
  formatMailTime,
  hasWiderReply,
  quoteBody,
  replyAllRecipients,
  replyRecipients,
  replySubject,
  summarizeRecipients,
  type MailPrefill,
} from "../lib/mailActions";
import { MailAttachmentCards } from "../features/MailAttachments";

/**
 * Reading pane for /app/mail/message/:mailId — one complete email.
 *
 * Renders in the SAME pane the list selects from, which is what makes Mail read
 * like a mail client rather than a list that navigates away. Nothing here
 * is truncated: the feed row carries a one-line preview and no body at all, so
 * this view is the only place the mail actually exists to the reader.
 *
 * ── Layout ───────────────────────────────────────────────────────────────────
 * The order a mail client puts things in, top to bottom:
 *   toolbar  — Reply / Reply all / Forward / Delete, pinned above the scroll so
 *              answering a long mail never means scrolling back up first.
 *   header   — subject, which folder this copy lives in, then who wrote it,
 *              who else got it, and when.
 *   body     — the message, whole, wrapped at a readable measure.
 *   files    — the attachments, via the same cards the composer's tray uses.
 * Only the last three scroll.
 *
 * ── Why the three answer actions are pure functions elsewhere ────────────────
 * Reply, Reply all and Forward differ ONLY in what they put in the composer,
 * and every one of those decisions (whose address, which prefix, what gets
 * quoted, whose Bcc is never carried over) is derivable from the mail already
 * on screen. They live in lib/mailActions as plain functions over a MailDTO so
 * the rules can be tested without a DOM, and this file stays a view.
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
  const [params] = useSearchParams();
  const folder = folderOf(params);
  // The list's own filters, carried into the composer and into the route this
  // falls back to after a delete — so answering or removing a mail returns to
  // the same filtered folder it was opened from rather than an unfiltered one.
  const listSearch = mailSearch(folder, peerOf(params));
  // A mail opened FROM Deleted Items is already deleted. Its toolbar offers the
  // undo rather than a Delete that would do nothing — the folder the reader
  // came from is the only thing that says which of the two this is, because the
  // mail itself is untouched by a delete (only the reader's feed row is).
  const isDeleted = folder === "deleted";

  // The signed-in address, needed to keep the reader off their own Reply all.
  // Empty until the session lands, which only ever means one extra address the
  // user can remove — never a missing recipient.
  const myAddress = useSession((s) => s.user?.email) ?? "";

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

  const remove = useMutation({
    mutationFn: () => (isDeleted ? api.restoreMail(mailId) : api.ignoreInboxItem("MAIL", mailId)),
    onSuccess: () => {
      toast.success(isDeleted ? "Restored to your mailbox" : "Moved to Deleted Items");
      void qc.invalidateQueries({ queryKey: qk.unifiedInbox });
      void qc.invalidateQueries({ queryKey: qk.inboxPeers });
      void qc.invalidateQueries({ queryKey: ["inboxPeerFeed"] });
      // The row moves BETWEEN the live feed and the wastebasket, so neither
      // listing is correct on its own afterwards.
      void qc.invalidateQueries({ queryKey: qk.deletedMail });
      nav({ pathname: "/app/mail/all", search: listSearch }, { replace: true });
    },
    onError: (e) =>
      toast.error(isDeleted ? "Could not restore" : "Could not remove", {
        description: errorText(e),
      }),
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

  /** Opens the composer on the same pane, prefilled for one of the three answers. */
  const compose = (prefill: MailPrefill) =>
    nav({ pathname: "/app/mail/compose", search: listSearch }, { state: prefill });

  const onReply = () =>
    compose({
      kind: "reply",
      to: replyRecipients(mail, myAddress),
      subject: replySubject(mail.subject),
      quoted: quoteBody(senderLabel, mail.sentAt, mail.bodyText),
    });

  const onReplyAll = () => {
    const { to: rTo, cc: rCc } = replyAllRecipients(mail, myAddress);
    compose({
      kind: "reply",
      to: rTo,
      cc: rCc,
      subject: replySubject(mail.subject),
      quoted: quoteBody(senderLabel, mail.sentAt, mail.bodyText),
    });
  };

  const onForward = () =>
    compose({
      kind: "forward",
      to: [],
      subject: forwardSubject(mail.subject),
      quoted: forwardBody(mail, senderLabel),
    });

  return (
    // @container: everything below sizes off THIS pane, not the viewport. The
    // two are nowhere near equal — with the rail and the sidebar beside it the
    // pane is ~396px at a 768px viewport — so a viewport breakpoint here shows
    // labels the pane has no room for, and the shell's overflow-hidden then
    // clips whatever is furthest right.
    <div className="@container flex h-full flex-col">
      <Toolbar
        mail={mail}
        myAddress={myAddress}
        onReply={onReply}
        onReplyAll={onReplyAll}
        onForward={onForward}
        onDelete={() => remove.mutate()}
        deleting={remove.isPending}
        deleted={isDeleted}
      />

      <div className="min-h-0 flex-1 overflow-auto">
        {/* One readable measure for the whole pane. A reading pane that grows
            to a 27" monitor otherwise sets prose at 200 characters a line. */}
        <div className="mx-auto w-full max-w-3xl px-4 py-4 sm:px-6 sm:py-6">
          <div className="flex items-start justify-between gap-3">
            <h1 className="min-w-0 text-lg font-semibold leading-snug tracking-tight text-fg sm:text-xl">
              {mail.subject || "(no subject)"}
            </h1>
            {/* Which side of this mail the reader is on. The same row is
                somebody's Sent and somebody else's Inbox. */}
            <Badge tone={mail.folder === "SENT" ? "neutral" : "accent"} className="mt-1 shrink-0">
              {mail.folder === "SENT" ? "sent" : "inbox"}
            </Badge>
          </div>

          <div className="mt-4 flex items-start gap-3">
            {mail.fromUserId ? (
              <Avatar name={senderLabel} size="lg" />
            ) : (
              // No account, so no initials worth deriving — the envelope says
              // "this came from outside" more clearly than a generated monogram.
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted">
                <Mail size={18} />
              </div>
            )}

            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-fg">{senderLabel}</div>
                  {mail.fromAddress && mail.fromAddress !== senderLabel && (
                    <div className="truncate text-xs text-muted">{mail.fromAddress}</div>
                  )}
                </div>
                {/* Time above date, the way a mail header reads at a glance.
                    The unabbreviated stamp stays on the tooltip. */}
                <div
                  title={formatMailTime(mail.sentAt)}
                  className="shrink-0 text-right text-xs tabular-nums text-muted"
                >
                  <div>{clock(mail.sentAt)}</div>
                  <div className="mt-0.5">{dayLabel(mail.sentAt)}</div>
                </div>
              </div>

              <div className="mt-1.5 space-y-0.5 text-xs">
                <AddressLine label="To" people={to} />
                <AddressLine label="Cc" people={cc} />
                {/* Server-filtered per viewer: the author sees the list they
                    typed, everyone else sees only their own entry. So a Bcc
                    shown here is never somebody else's. */}
                <AddressLine label="Bcc" people={bcc} />
              </div>
            </div>
          </div>

          <div className="mt-6 whitespace-pre-wrap break-words text-[15px] leading-relaxed text-fg">
            {mail.bodyText || <span className="text-muted">(no message body)</span>}
          </div>

          {/* The same cards the composer's tray renders, so a file looks the
              same on both ends of the send. Renders nothing when there are none. */}
          <MailAttachmentCards attachments={mail.attachments} />
        </div>
      </div>
    </div>
  );
}

/**
 * The action bar above the mail.
 *
 * Reply all only appears when there is somebody else to include — on a mail
 * addressed to you alone it would produce exactly the same composer as Reply,
 * and two buttons that do the same thing is worse than one.
 *
 * Labels collapse to icons below `sm`, where four labelled buttons would wrap;
 * the accessible name and the tooltip stay in both states.
 */
function Toolbar({
  mail,
  myAddress,
  onReply,
  onReplyAll,
  onForward,
  onDelete,
  deleting,
  deleted,
}: {
  mail: MailDTO;
  myAddress: string;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  /** Delete, or Restore when the mail is already in Deleted Items. */
  onDelete: () => void;
  deleting: boolean;
  /** Opened from Deleted Items — the last control is the undo, not the delete. */
  deleted: boolean;
}) {
  const canReplyAll = hasWiderReply(mail, myAddress);

  return (
    // Scrollable as a backstop: whatever the labels do, the pane can always be
    // narrower than four controls, and a clipped Delete is an unreachable one.
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/60 px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <Action icon={<Reply size={16} />} label="Reply" title="Reply to the sender" onClick={onReply} />
      {canReplyAll && (
        <Action
          icon={<ReplyAll size={16} />}
          label="Reply all"
          title="Reply to everyone on this mail"
          onClick={onReplyAll}
        />
      )}
      <Action
        icon={<Forward size={16} />}
        label="Forward"
        title="Forward this mail to someone else"
        onClick={onForward}
      />
      <div className="ml-auto" />
      <Action
        icon={deleted ? <Undo2 size={16} /> : <Trash2 size={16} />}
        label={deleted ? "Restore" : "Delete"}
        title={
          deleted
            ? "Restore — puts this mail back in the folder it came from"
            : "Delete — removes your copy only; nobody else's is affected"
        }
        tone={deleted ? "default" : "danger"}
        disabled={deleting}
        onClick={onDelete}
      />
    </div>
  );
}

function Action({
  icon,
  label,
  title,
  tone = "default",
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  title: string;
  tone?: "default" | "danger";
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors disabled:opacity-50 ${
        tone === "danger"
          ? "text-muted hover:bg-surface-2 hover:text-danger"
          : "text-fg/80 hover:bg-accent-soft hover:text-accent"
      }`}
    >
      {icon}
      <span className="hidden @lg:inline">{label}</span>
    </button>
  );
}

/**
 * One line of the address header. The first few addressees by name, then how
 * many were left out — a mail to a whole team otherwise renders a header
 * taller than the message. The full list stays on the tooltip.
 */
function AddressLine({ label, people }: { label: string; people: MailRecipientDTO[] }) {
  if (people.length === 0) return null;
  return (
    <div className="truncate text-muted" title={allRecipients(people)}>
      <span className="text-muted/70">{label}: </span>
      {summarizeRecipients(people)}
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
