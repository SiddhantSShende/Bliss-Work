/**
 * Client-side email address validation for the mail composer.
 *
 * ── Why this lives in shared, and why it is a copy ───────────────────────────
 * The authority is the SERVER: messaging-svc validates and normalizes every
 * address before it stores or sends one (store.NormalizeMailAddress), and the
 * SMTP relay validates again on the way out (email-worker's is_valid_email).
 * This exists purely so the composer can grey out Send and mark a bad chip
 * before a round trip — never as the thing that decides what is deliverable.
 *
 * The three implementations MUST agree on what passes. A composer that accepts
 * an address the server rejects turns a typo into a failed send after the fact;
 * one that rejects an address the server accepts makes a deliverable mail
 * unsendable, which is worse because the user has no way to argue with it. So
 * the regex is deliberately identical to the other two, permissive on purpose,
 * and NOT an attempt at RFC 5322 — it catches the common garbage (empty, no @,
 * whitespace, no domain dot) and defers everything else to the mail server that
 * will actually have to deliver it.
 */

/** RFC 5321 §4.5.3.1.3 — the longest address any server must accept. */
export const MAX_MAIL_ADDRESS_LENGTH = 254;

const MAIL_ADDRESS_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Trims and lower-cases an address, or returns "" if it is not deliverable.
 *
 * Lower-casing the local part is technically lossy — RFC 5321 makes only the
 * domain case-insensitive — but no mail system in practical use treats "Jane@"
 * and "jane@" as different people, and matching the org directory depends on
 * both sides agreeing on one form.
 */
export function normalizeMailAddress(raw: string): string {
  const a = raw.trim().toLowerCase();
  if (!a || a.length > MAX_MAIL_ADDRESS_LENGTH || !MAIL_ADDRESS_RE.test(a)) return "";
  return a;
}

/** True when `raw` is an address the server will accept. */
export function isValidMailAddress(raw: string): boolean {
  return normalizeMailAddress(raw) !== "";
}

/**
 * Splits a pasted string into candidate addresses.
 *
 * People paste recipient lists out of other mail clients, spreadsheets and
 * chat messages, so the separators that show up in practice are commas,
 * semicolons, newlines and plain spaces. Splitting here means a paste becomes
 * chips instead of one long invalid token.
 */
export function splitMailAddresses(raw: string): string[] {
  return raw
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}
