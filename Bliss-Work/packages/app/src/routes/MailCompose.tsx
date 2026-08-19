import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Paperclip, PenSquare, Send, Trash2, X, Loader2, AlertCircle } from "lucide-react";
import { Button, Input, Textarea } from "@taskboard/ui";
import { isValidMailAddress } from "@taskboard/shared";
import { toast } from "sonner";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { errorText } from "../lib/errorText";
import { MailAddressField } from "../features/MailAddressField";
import { MailAttachmentTray, useMailAttachments } from "../features/MailAttachments";
import { useMailDraft } from "../features/useMailDraft";
import type { MailPrefill } from "../lib/mailActions";

/** Mirrors store.MaxMailSubjectRunes. Enforced server-side; this is the counter. */
const MAX_SUBJECT = 200;

/**
 * Main pane content for /app/mail/compose — writing an email.
 *
 * Occupies the SAME pane a mail is read in, so New Mail and opening a mail are
 * the same gesture rather than a modal covering the list you are addressing
 * from.
 *
 * ── The draft ────────────────────────────────────────────────────────────────
 * A server-side draft is opened as soon as this mounts, before anything is
 * typed. That is not bookkeeping for its own sake: an attachment upload has to
 * be authorized against a destination that already exists, and the draft id is
 * what those uploads scope to (see 0023_mail.sql).
 *
 * What is typed is written back to that draft after a pause and again on close,
 * so leaving without sending KEEPS the mail — it appears in Drafts and this
 * same component reopens it at /app/mail/compose/:draftId. A composer that was
 * opened and never written in is discarded instead; see useMailDraft.
 */
export function MailCompose() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const nav = useNavigate();
  // Present when resuming from the Drafts folder, absent for a new mail.
  const { draftId } = useParams<{ draftId?: string }>();
  // Reply / Reply all / Forward arrive as router state rather than query
  // params: the quoted body can be thousands of characters, which does not
  // belong in a URL. Absent for a plain New Mail, which is why every field
  // falls back to empty. What each answer puts here is decided in
  // lib/mailActions — this component only receives it.
  const loc = useLocation();
  const prefill = (loc.state ?? {}) as Partial<MailPrefill>;

  // A resumed draft's contents. Fetched through the same endpoint a mail is
  // read with — a draft IS a mail, and its author is entitled to read it — so
  // there is no second shape to keep in step.
  const resumed = useQuery({
    queryKey: qk.mail(draftId!),
    queryFn: () => api.mail(draftId!),
    enabled: !!draftId,
    // The composer is the only writer, and it holds what it typed. A refetch
    // that landed mid-sentence would fight the person writing.
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });

  const [to, setTo] = useState<string[]>(prefill.to ?? []);
  const [cc, setCc] = useState<string[]>(prefill.cc ?? []);
  const [bcc, setBcc] = useState<string[]>([]);
  // Reply all carries a Cc line, and a Cc the user cannot see is one they
  // cannot remove — so the field starts open whenever it starts populated.
  const [showCc, setShowCc] = useState((prefill.cc?.length ?? 0) > 0);
  const [subject, setSubject] = useState(prefill.subject ?? "");
  const [body, setBody] = useState(prefill.quoted ?? "");
  const isReply = !!prefill.subject || (prefill.to?.length ?? 0) > 0;
  // A forward starts with no addressee — it is the one answer that still needs
  // one typed — so it is titled for what it is rather than lumped in with Reply.
  const heading = draftId
    ? "Draft"
    : prefill.kind === "forward"
      ? "Forward"
      : isReply
        ? "Reply"
        : "New Mail";

  // Fill the form from the resumed draft, ONCE — keyed on the mail id, not on
  // the query result, so a refetch cannot overwrite what is being typed.
  const [loadedId, setLoadedId] = useState<string | undefined>(undefined);
  useEffect(() => {
    const mail = resumed.data;
    if (!mail || mail.mailId === loadedId) return;
    setLoadedId(mail.mailId);
    setTo(mail.recipients.filter((r) => r.kind === "TO").map((r) => r.address));
    const ccAddresses = mail.recipients.filter((r) => r.kind === "CC").map((r) => r.address);
    setCc(ccAddresses);
    setBcc(mail.recipients.filter((r) => r.kind === "BCC").map((r) => r.address));
    // Same rule as a reply-all: a Cc the user cannot see is one they cannot
    // remove, so the field opens whenever it is populated.
    if (ccAddresses.length > 0) setShowCc(true);
    setSubject(mail.subject);
    setBody(mail.bodyText);
  }, [resumed.data, loadedId]);

  // Opening the draft is a real network call that can fail; the composer stays
  // usable (typing is local) but Send and attachments wait on it, so its state
  // has to be visible rather than assumed. The hook also discards the draft if
  // the composer is left without sending — see useMailDraft.
  const draft = useMailDraft(draftId);
  const { mailId } = draft;

  const attachments = useMailAttachments(mailId, resumed.data?.attachments);

  // Autosave. Runs on every change rather than on a timer of its own: the hook
  // debounces, and what it must never miss is the LAST edit before the composer
  // closes — which it reads from here.
  const { save: saveDraft } = draft;
  useEffect(() => {
    if (!mailId) return;
    // Nothing is written until the resumed draft has actually loaded, or the
    // first save would overwrite the mail with an empty form.
    if (draftId && !resumed.data) return;
    saveDraft({
      to,
      cc,
      bcc,
      subject,
      bodyText: body,
      hasAttachments: attachments.files.length > 0,
    });
  }, [mailId, draftId, resumed.data, saveDraft, to, cc, bcc, subject, body, attachments.files.length]);

  const allAddresses = [...to, ...cc, ...bcc];
  const invalidAddress = allAddresses.find((a) => !isValidMailAddress(a));
  const subjectTooLong = subject.length > MAX_SUBJECT;
  const canSend =
    !!mailId &&
    allAddresses.length > 0 &&
    !invalidAddress &&
    !subjectTooLong &&
    !attachments.isUploading;

  /**
   * Throw the draft away and leave.
   *
   * Separate from Close, which now keeps it: with autosave, "get rid of this"
   * has to be something the user can actually say. Navigating happens whether
   * or not the delete succeeded — the composer is closed either way, and a
   * draft that outlived a failed delete is still the user's own unsent mail,
   * sitting in Drafts where they can try again.
   */
  const discardDraft = async () => {
    try {
      await draft.discard();
      toast.success("Draft discarded");
    } catch (e) {
      toast.error("Could not discard the draft", { description: errorText(e) });
    }
    nav({ pathname: "/app/mail/all", search: loc.search }, { replace: true });
  };

  const send = useMutation({
    mutationFn: async () => {
      if (!mailId) throw new Error("draft not ready");
      return api.sendMail(mailId, { to, cc, bcc, subject: subject.trim(), bodyText: body });
    },
    onSuccess: (res) => {
      draft.markSent();
      toast.success(sentSummary(res.deliveredInApp, res.queuedExternal));
      void qc.invalidateQueries({ queryKey: qk.unifiedInbox });
      void qc.invalidateQueries({ queryKey: qk.inboxPeers });
      void qc.invalidateQueries({ queryKey: ["inboxPeerFeed"] });
      // The draft just stopped being one. Without this the Drafts folder —
      // frequently on screen beside this pane — keeps listing a mail that is
      // now in Sent Items.
      void qc.invalidateQueries({ queryKey: qk.mailDrafts });
      void qc.invalidateQueries({ queryKey: qk.mail(res.mailId) });
      // Keep the list's filters (?box=, ?p=) on the way out. A bare pathname
      // would drop them, so the folder the user was writing from silently
      // resets to the Inbox behind the mail they just sent.
      nav({ pathname: `/app/mail/message/${res.mailId}`, search: loc.search }, { replace: true });
    },
    // The server names the field that is wrong (a rejected address, an
    // over-long subject), so its message is more useful than anything we could
    // synthesize here. It is also rendered inline below, not only as a toast —
    // a toast that has faded is no help to someone still fixing the form.
    onError: (e) => toast.error("Could not send", { description: errorText(e) }),
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-fg">
          <PenSquare size={16} className="text-accent" /> {heading}
        </div>
        <button
          onClick={() => nav(-1)}
          // Closing KEEPS the mail now — it is saved to Drafts on the way out
          // (useMailDraft), and only a composer with nothing in it is thrown
          // away. Discarding on purpose is the button in the footer.
          title="Close — keeps this in Drafts"
          aria-label="Close — keeps this in Drafts"
          className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-fg"
        >
          <X size={16} />
        </button>
      </div>

      {draft.isError && (
        <Banner
          tone="danger"
          text="Could not start a draft. Check your connection and try again."
          action={
            <Button size="sm" variant="ghost" onClick={draft.retry}>
              Retry
            </Button>
          }
        />
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend && !send.isPending) send.mutate();
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          <div className="flex flex-col gap-3">
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <MailAddressField
                  label="To"
                  value={to}
                  onChange={setTo}
                  placeholder="name@company.com"
                  autoFocus={to.length === 0}
                />
              </div>
              {!showCc && (
                <button
                  type="button"
                  onClick={() => setShowCc(true)}
                  className="mb-2.5 shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-muted hover:bg-surface-2 hover:text-fg"
                >
                  Cc / Bcc
                </button>
              )}
            </div>

            {showCc && (
              <>
                <MailAddressField label="Cc" value={cc} onChange={setCc} placeholder="Copy someone" />
                <MailAddressField
                  label="Bcc"
                  value={bcc}
                  onChange={setBcc}
                  placeholder="Blind copy — hidden from everyone else"
                />
              </>
            )}

            <label className="flex flex-col gap-1.5">
              <span className="flex items-baseline justify-between text-[13px] font-medium text-fg/80">
                Subject
                {subject.length > MAX_SUBJECT * 0.9 && (
                  <span className={subjectTooLong ? "text-danger" : "text-muted"}>
                    {subject.length}/{MAX_SUBJECT}
                  </span>
                )}
              </span>
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="What is this about?"
                aria-invalid={subjectTooLong}
              />
            </label>

            <label className="flex min-h-0 flex-col gap-1.5">
              <span className="text-[13px] font-medium text-fg/80">Message</span>
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Write your email…"
                className="min-h-56"
              />
            </label>

            <MailAttachmentTray {...attachments} />
          </div>
        </div>

        {/* Why Send can't be pressed, stated where the button is rather than
            leaving a greyed-out control with no explanation. */}
        {(invalidAddress || subjectTooLong || send.isError) && (
          <Banner
            tone="danger"
            text={
              invalidAddress
                ? `"${invalidAddress}" does not look like an email address.`
                : subjectTooLong
                  ? `Subject is ${subject.length} characters — the limit is ${MAX_SUBJECT}.`
                  : errorText(send.error)
            }
          />
        )}

        <div className="flex items-center justify-between gap-2 border-t border-border/60 px-4 py-3">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={attachments.pick}
              disabled={!mailId}
              title={mailId ? "Attach files" : "Preparing draft…"}
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-40"
            >
              <Paperclip size={14} /> Attach
            </button>
            <input {...attachments.inputProps} />
            {attachments.files.length > 0 && (
              <button
                type="button"
                onClick={attachments.clear}
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-surface-2 hover:text-danger"
              >
                <Trash2 size={14} /> Remove all
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {draft.isLoading && (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-muted">
                <Loader2 size={12} className="animate-spin" /> Preparing…
              </span>
            )}
            <Button
              type="button"
              variant="ghost"
              onClick={() => void discardDraft()}
              title="Discard — deletes this draft; it has not been sent to anyone"
            >
              Discard
            </Button>
            <Button type="button" variant="ghost" onClick={() => nav(-1)}>
              Close
            </Button>
            <Button type="submit" loading={send.isPending} disabled={!canSend || send.isPending}>
              <Send size={15} /> {send.isPending ? "Sending…" : "Send"}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

/**
 * What actually happened, rather than a bare "Sent".
 *
 * A mail addressed both inside and outside the org does two different things,
 * and only one of them has already finished: colleagues have it now; external
 * copies are queued for SMTP and land when the relay delivers them.
 */
function sentSummary(inApp: number, external: number): string {
  if (external === 0) return inApp === 1 ? "Sent" : `Sent to ${inApp} people`;
  if (inApp === 0) return external === 1 ? "Sent — delivering" : `Sent — delivering to ${external}`;
  return `Sent to ${inApp} here, delivering to ${external} more`;
}

function Banner({
  tone,
  text,
  action,
}: {
  tone: "danger";
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      role="alert"
      className={`flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2 text-xs ${
        tone === "danger" ? "bg-danger/8 text-danger" : ""
      }`}
    >
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <AlertCircle size={13} className="shrink-0" />
        <span className="truncate">{text}</span>
      </span>
      {action}
    </div>
  );
}
