import type { InboxItemKind } from "@taskboard/shared";

/**
 * What the Inbox is a list of.
 *
 * MAIL, plus the THREAD rows the older mail-origin compose path wrote, so that
 * nothing anyone already sent disappears from view.
 *
 * TASK is deliberately absent. The projector still writes those rows and
 * /app/inbox/task/:id still resolves, so every existing deep link and
 * notification target keeps working — a task assigned to you is a real thing
 * that happened. It just belongs in Tasks, which is a whole section with a
 * state machine behind it, not a row in a mail list.
 *
 * ── Why this is ONE constant rather than three literals ──────────────────────
 * It is sent to the server by three surfaces that share one cache entry each:
 * the feed (GET /inbox), the People sidebar and the left-rail badge (both GET
 * /inbox/peers). If they disagreed, two of them would fight over the same
 * `qk.inboxPeers` entry with different data, and the badge would count rows the
 * list does not show — a "3" the user cannot find. Single-sourcing it is what
 * makes that unrepresentable.
 */
export const INBOX_KINDS: InboxItemKind[] = ["MAIL", "THREAD"];
