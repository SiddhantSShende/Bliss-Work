/**
 * View-level logic for Mail — the parts of "how the mailbox reads" that are
 * pure functions over what the server already sends.
 *
 * They live here rather than inside the components so the folder column and the
 * message list can be reasoned about (and unit-tested) without a DOM: none of
 * this touches the API, and none of it invents a field the feed does not carry.
 */
import type { InboxItemDTO } from "@taskboard/shared";
import { clock, dayLabel } from "./chatFormat";

/** The folders the folder column lists. */
export type MailFolder = "inbox" | "sent" | "drafts" | "deleted" | "spam";

/** One row of the folder column. */
export interface FolderSpec {
  key: MailFolder;
  label: string;
  /**
   * Why this folder can never have anything in it, in the reader's words.
   *
   * Set on the three folders the server has no listing behind (see
   * MAIL_FOLDERS). Absent on the two that are backed by the feed. The message
   * column renders it INSTEAD of a list, so a folder that is structurally empty
   * says why rather than implying the mail went missing.
   */
  unavailable?: string;
}

/**
 * The folder list, in the order a mail client puts them.
 *
 * Only the first two are backed by data. `inbox` and `sent` are the two sides of
 * the one feed the server returns, told apart by `statusBadge` (see isOutgoing),
 * so both are real listings of real mail.
 *
 * The other three exist in the UI because a mailbox is expected to have them,
 * and each one carries the reason it is empty rather than pretending to be a
 * listing that has not loaded yet:
 *   drafts  — a draft is created when the composer opens and discarded when it
 *             closes (see useMailDraft); nothing projects one into a feed, and
 *             there is no endpoint that lists them.
 *   deleted — deleting a mail sets hidden_for_owner, and the server filters
 *             those rows out of every response. Nothing can list them back.
 *   spam    — there is no spam classification anywhere in the product.
 * All three would need messaging-svc to grow an endpoint before they could hold
 * anything, so the honest thing is to say so in the folder itself.
 */
export const MAIL_FOLDERS = [
  { key: "inbox", label: "Inbox" },
  { key: "sent", label: "Sent Items" },
  {
    key: "drafts",
    label: "Drafts",
    unavailable:
      "A message you are writing lives in the composer until you send it — unsent mail is not kept here.",
  },
  {
    key: "deleted",
    label: "Deleted Items",
    unavailable:
      "Deleting a mail removes your copy for good. There is no recovery folder behind it, so nothing lands here.",
  },
  {
    key: "spam",
    label: "Spam",
    unavailable: "Mail is never sorted into spam — everything that arrives lands in your Inbox.",
  },
] as const satisfies readonly FolderSpec[];

/** The folder's spec, for its label and for whether it can list anything. */
export function folderSpec(folder: MailFolder): FolderSpec {
  return MAIL_FOLDERS.find((f) => f.key === folder) ?? MAIL_FOLDERS[0];
}

/** Can the feed answer for this folder at all? See MAIL_FOLDERS. */
export function isListableFolder(folder: MailFolder): boolean {
  return folderSpec(folder).unavailable === undefined;
}

/**
 * Whether a row is the caller's OWN copy of something they sent.
 *
 * `statusBadge` is the only direction signal the feed carries, and it is
 * written on the author's side only:
 *   MAIL   — messaging-svc stamps 'SENT' on the author's row when the mail is
 *            delivered; every recipient's row is left NULL (mail_deliver.go).
 *   THREAD — 'SENT'/'DELIVERED'/'SEEN' is the sender-side receipt, and it
 *            sticks to the row once set, so it means "this is my side of the
 *            conversation" rather than "the last message was mine".
 */
export function isOutgoing(item: InboxItemDTO): boolean {
  return item.statusBadge !== null;
}

/** Does this row belong in the selected folder? */
export function inFolder(item: InboxItemDTO, folder: MailFolder): boolean {
  if (folder === "sent") return isOutgoing(item);
  if (folder === "inbox") return !isOutgoing(item);
  // Drafts / Deleted Items / Spam are never projected into the feed, so no row
  // the feed carries can belong to one.
  return false;
}

/**
 * Splits the one-line preview the server builds for a MAIL row back into the
 * two things a mail list shows: what it is about, and how it starts.
 *
 * messaging-svc joins them as `subject — body` (store/mail_send.go), so the
 * FIRST separator is the subject boundary. A subject that itself contains an
 * em dash therefore gives up its tail to the snippet — purely a matter of
 * which half is bold, which is why this stays a presentation helper and the
 * row still renders the whole preview either way.
 */
export function splitMailPreview(preview: string): { subject: string; snippet: string } {
  const at = preview.indexOf(" — ");
  if (at < 0) return { subject: preview, snippet: "" };
  return { subject: preview.slice(0, at), snippet: preview.slice(at + 3) };
}

/** One date bucket of the list — "Today", "Yesterday", "12 Jun". */
export interface DayGroup {
  label: string;
  items: InboxItemDTO[];
}

/**
 * Buckets rows under the day they last moved. The feed arrives newest-first
 * and stays in that order; this only inserts the boundaries.
 */
export function groupByDay(items: InboxItemDTO[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const item of items) {
    const label = dayLabel(item.lastEventAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

/** Mail-client timestamp: the clock for today, the day for anything older. */
export function listTime(iso: string): string {
  const day = dayLabel(iso);
  return day === "Today" ? clock(iso) : day;
}

/**
 * Is this pathname one that opens a single item in the reading pane?
 *
 * The list routes (`/app/mail`, `/app/mail/all`) and the detail routes are
 * siblings under one layout, so the layout has to tell them apart to decide
 * what a narrow window shows — the list, or the thing that was opened from it.
 */
export function isMailDetailPath(pathname: string): boolean {
  return /^\/app\/mail\/(message|thread|task|compose)(\/|$)/.test(pathname);
}

/**
 * Where an /app/inbox/… URL points now that the section is /app/mail.
 *
 * The section was renamed; the URLs it lived at were not retired. Links to them
 * exist in the wild and are not all ours to update — a bookmark, a tab left
 * open across a deploy, and in particular the "open BlissWork" link the email
 * worker puts in every notification mail it sends (relay_consumer.py builds
 * `{web_base_url}/app/inbox`). Every one of those still has to land on the
 * mailbox.
 *
 * Two segments moved rather than merely being re-rooted, so they are translated
 * rather than copied through:
 *   mail/:id  → message/:id, because /app/mail/mail/:id reads as a mistake.
 *   p/:peerId → the list route with ?p=, which is where the person filter went
 *               when it stopped being a path segment.
 * Anything else lands on the mailbox rather than 404-ing: it was a valid Inbox
 * URL at some point, and the mailbox is what it was reaching for.
 *
 * @param rest   the path AFTER /app/inbox — "", "all", "mail/<id>", "p/<id>"…
 * @param search the query string it arrived with, kept so ?box= and ?p= survive
 */
export function legacyInboxTarget(
  rest: string,
  search = "",
): { pathname: string; search: string } {
  const [head, ...tail] = rest.replace(/^\/+|\/+$/g, "").split("/");

  if (head === "p" && tail[0]) {
    // Merged into the search rather than replacing it, so a ?box= that came
    // along on the old URL is not thrown away on the way to the new one.
    const qs = new URLSearchParams(search);
    qs.set("p", tail[0]);
    return { pathname: "/app/mail/all", search: `?${qs.toString()}` };
  }
  if (head === "mail" && tail[0]) {
    return { pathname: `/app/mail/message/${tail[0]}`, search };
  }
  const kept =
    head === "all" || head === "compose" || ((head === "thread" || head === "task") && !!tail[0]);
  return { pathname: kept ? `/app/mail/${head}${tail.length ? `/${tail.join("/")}` : ""}` : "/app/mail", search };
}

/**
 * ── Why the folder and the person are query params ───────────────────────────
 *
 * Both narrow the LIST, and the list is a sibling of the reading pane rather
 * than its parent: opening a mail routes to /app/mail/message/:id, which shares
 * no path segment with the list route it was opened from. A path-encoded
 * filter would therefore be dropped the moment anything is read, and the way
 * back would land in an unfiltered mailbox.
 *
 * The search string survives all of it — the detail routes, a reload, a shared
 * link — and the folder column (which lives in the app shell, one level ABOVE
 * this route) can read and write it just as easily as the list can.
 *
 * The param is still spelled `box=`, which is what the mailbox filter that came
 * before the folders was called. Renaming it would break every link already in
 * the wild for no gain the reader can see.
 */

/** The selected folder, defaulting to the Inbox for an absent or unknown value. */
export function folderOf(search: URLSearchParams): MailFolder {
  const box = search.get("box");
  return MAIL_FOLDERS.some((f) => f.key === box) ? (box as MailFolder) : "inbox";
}

/** The selected counterparty, or undefined for "everyone". */
export function peerOf(search: URLSearchParams): string | undefined {
  return search.get("p") ?? undefined;
}

/**
 * The search string every Mail link carries.
 *
 * Rebuilt from the two values rather than passed through verbatim so no
 * unrelated query param rides along into every row's href, and defaults are
 * omitted so the plain mailbox stays at a clean /app/mail/all.
 */
export function mailSearch(folder: MailFolder, peerId?: string | null): string {
  const qs = new URLSearchParams();
  if (folder !== "inbox") qs.set("box", folder);
  if (peerId) qs.set("p", peerId);
  const s = qs.toString();
  return s ? `?${s}` : "";
}
