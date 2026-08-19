/**
 * Reply / Reply all / Forward — what each one puts in the composer.
 *
 * All pure, and all derived from the mail already on screen: none of these
 * needs an endpoint the app does not have. The composer is reached by routing
 * to it with this as router state (see MailCompose), so everything here is
 * plain data.
 */
import type { MailDTO, MailRecipientDTO } from "@taskboard/shared";

/** What a reply/forward hands the composer. */
export interface MailPrefill {
  to: string[];
  cc?: string[];
  subject: string;
  quoted: string;
  /** Titles the composer, which is otherwise the same form for all three. */
  kind: "reply" | "forward";
}

/** "Re: x" — and not "Re: Re: x", which is what makes a subject grow a prefix
 *  per reply in clients that skip this check. */
export function replySubject(subject: string): string {
  const s = subject.trim();
  if (!s) return "Re:";
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/** "Fwd: x", with the same no-double-prefix rule. */
export function forwardSubject(subject: string): string {
  const s = subject.trim();
  if (!s) return "Fwd:";
  return /^fwd?:/i.test(s) ? s : `Fwd: ${s}`;
}

/** The address a mail is answered to, with the display name dropped — the
 *  composer validates and sends bare addresses. */
function addressesOf(people: MailRecipientDTO[]): string[] {
  return people.map((p) => p.address).filter(Boolean);
}

function withoutMe(addresses: string[], myAddress: string): string[] {
  const me = myAddress.trim().toLowerCase();
  const seen = new Set<string>();
  return addresses.filter((a) => {
    const key = a.trim().toLowerCase();
    if (!key || key === me || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Reply: the sender alone. */
export function replyTo(mail: MailDTO): string[] {
  return mail.fromAddress ? [mail.fromAddress] : [];
}

/**
 * Who a plain Reply actually addresses.
 *
 * The sender — except on a mail YOU sent, where the sender IS you and there is
 * nobody there to answer. Replying to your own Sent copy would otherwise mail
 * the thread back to yourself, which is never what the button means; every mail
 * client reads Reply in a Sent folder as "write to those people again", so the
 * original To line takes over.
 *
 * Decided from the addresses rather than from `mail.folder` so the awkward
 * cases fall out on their own: a mail you sent to yourself, or a Sent copy
 * whose From is an alias, both answer somebody real or nobody at all — never
 * the reader.
 */
export function replyRecipients(mail: MailDTO, myAddress: string): string[] {
  const sender = withoutMe(replyTo(mail), myAddress);
  if (sender.length > 0) return sender;
  return withoutMe(addressesOf(mail.recipients.filter((r) => r.kind === "TO")), myAddress);
}

/**
 * Would Reply all reach anybody Reply would not?
 *
 * The only honest test is to work both answers out and compare them: on a mail
 * addressed to you alone the two produce an identical composer, and offering
 * both then asks the reader to choose between two buttons that do the same
 * thing. Counting recipients instead gets this wrong in both directions — a Bcc
 * copy has a To line full of people the reader is not among, and a two-name To
 * line can still collapse to one once the reader is removed from it.
 */
export function hasWiderReply(mail: MailDTO, myAddress: string): boolean {
  const narrow = new Set(replyRecipients(mail, myAddress).map((a) => a.toLowerCase()));
  const { to, cc } = replyAllRecipients(mail, myAddress);
  return [...to, ...cc].some((a) => !narrow.has(a.toLowerCase()));
}

/**
 * Reply all: the sender plus everyone who was on the To line, with the Cc line
 * kept as Cc. The caller's own address is dropped from both — answering a
 * group should not put a copy back in your own inbox.
 *
 * On your OWN sent mail there is no sender to answer, so the original To line
 * becomes the To line: "reply all" to something you wrote means writing to the
 * same people again. Bcc is never carried over; it was blind when it was sent
 * and quoting it back would out it.
 */
export function replyAllRecipients(
  mail: MailDTO,
  myAddress: string,
): { to: string[]; cc: string[] } {
  const to = withoutMe(
    [...replyTo(mail), ...addressesOf(mail.recipients.filter((r) => r.kind === "TO"))],
    myAddress,
  );
  const cc = withoutMe(addressesOf(mail.recipients.filter((r) => r.kind === "CC")), myAddress).filter(
    (a) => !to.some((t) => t.toLowerCase() === a.toLowerCase()),
  );
  return { to, cc };
}

/** Absolute timestamp for a mail header — the one place a mail's time is
 *  spelled out in full rather than as "3h". */
export function formatMailTime(iso: string): string {
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

/** The quoted original, in the plain-text convention every mail client renders. */
export function quoteBody(sender: string, sentAt: string, body: string): string {
  const quoted = body
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `\n\nOn ${formatMailTime(sentAt)}, ${sender} wrote:\n${quoted}\n`;
}

/**
 * The forwarded block: the original header, then the original body verbatim.
 *
 * Attachments are NAMED but not carried — the composer uploads files against
 * its own draft and there is no server-side "copy these attachments onto that
 * draft" operation. Listing them is what stops a forward from silently losing
 * the very thing it was sent to pass on; the sender can re-attach from the
 * original, which is still in their mailbox.
 */
export function forwardBody(mail: MailDTO, senderLabel: string): string {
  const lines = [
    "",
    "",
    "---------- Forwarded message ----------",
    `From: ${senderLabel}${mail.fromAddress ? ` <${mail.fromAddress}>` : ""}`,
    `Date: ${formatMailTime(mail.sentAt)}`,
    `Subject: ${mail.subject || "(no subject)"}`,
  ];
  const to = mail.recipients.filter((r) => r.kind === "TO");
  if (to.length) lines.push(`To: ${to.map((r) => r.displayName ?? r.address).join(", ")}`);
  if (mail.attachments.length) {
    lines.push(`Attachments: ${mail.attachments.map((a) => a.filename).join(", ")}`);
  }
  lines.push("", mail.bodyText);
  return lines.join("\n");
}

/**
 * The To/Cc line as a mail client writes it: the first few by name, then how
 * many were left out.
 *
 * A mail sent to a whole team otherwise renders as a header taller than the
 * message under it. Three is what fits on one line at the reading pane's
 * narrowest, and the full list is never lost — it is the element's `title`.
 */
export function summarizeRecipients(people: MailRecipientDTO[], max = 3): string {
  const names = people.map((p) => p.displayName || p.address).filter(Boolean);
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} + ${names.length - max} more`;
}

/** Every addressee spelled out — the `title` behind the summary above. */
export function allRecipients(people: MailRecipientDTO[]): string {
  return people.map((p) => (p.displayName ? `${p.displayName} <${p.address}>` : p.address)).join(", ");
}
