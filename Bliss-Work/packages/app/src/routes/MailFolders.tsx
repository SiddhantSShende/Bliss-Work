import { Link, useSearchParams } from "react-router-dom";
import {
  FileEdit,
  Inbox as InboxIcon,
  Send,
  ShieldAlert,
  Trash2,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Avatar } from "@taskboard/ui";
import { peerLabel, useInboxPeers, type InboxPeerView } from "../lib/useInboxPeers";
import { ListHeader, rowClass } from "../features/ListPane";
import { relative } from "../lib/chatFormat";
import { MAIL_FOLDERS, type MailFolder, mailSearch, folderOf, peerOf } from "../lib/mailView";

/**
 * Where every control in this column navigates to.
 *
 * The explicit list route, never the /app/mail index, for two reasons: from a
 * reading pane a bare search change would leave the mail open and silently
 * re-filter the list behind it, and on a phone — where the shell shows this
 * column OR the pane beside it, never both — the third path segment is what
 * tells the shell to show the list the user just filtered.
 */
const LIST_PATH = "/app/mail/all";

/** The icon each folder row carries. */
const FOLDER_ICONS: Record<MailFolder, LucideIcon> = {
  inbox: InboxIcon,
  sent: Send,
  drafts: FileEdit,
  deleted: Trash2,
  spam: ShieldAlert,
};

/**
 * Mail's first container: the folders, and the people underneath them.
 *
 * This is the column the app shell puts beside the rail, and the only place the
 * folder itself is chosen. Two things stacked:
 *   Folders — Inbox, Sent Items, Drafts, Deleted Items and Spam, written into
 *             the URL as ?box= so the message list and the reading pane both
 *             see the same choice. Only the first two can hold anything; the
 *             other three say why they cannot (see lib/mailView) rather than
 *             looking like a listing that failed to load.
 *   People  — every counterparty the user has exchanged mail with, newest
 *             activity first. Selecting one adds ?p=<id>, which narrows the
 *             message list to that person server-side.
 *
 * The two filters compose: picking a person keeps the folder, and switching
 * folder keeps the person. That is why every link here is built from the pair
 * rather than from the one control that owns it.
 *
 * New Mail is deliberately NOT here — it belongs beside the All/Unread filters
 * in the message list, which is the container it acts on.
 */
export function MailFolders() {
  const [params] = useSearchParams();
  const folder = folderOf(params);
  const peerId = peerOf(params);

  const { data: peers = [] } = useInboxPeers();
  const unread = peers.reduce((sum, p) => sum + (p.unreadCount || 0), 0);

  return (
    <>
      <ListHeader title="Mail" />

      <nav className="shrink-0 space-y-0.5 px-2 pb-2 pt-2">
        {MAIL_FOLDERS.map((box) => {
          const Icon = FOLDER_ICONS[box.key];
          const active = box.key === folder;
          // Unread mail is by definition mail that arrived, so the rollup
          // belongs on the Inbox alone. The other folders carry no count rather
          // than a plausible-looking one the server never sent.
          const showRollup = box.key === "inbox" && unread > 0;
          return (
            <Link
              key={box.key}
              to={{ pathname: LIST_PATH, search: mailSearch(box.key, peerId) }}
              aria-current={active ? "page" : undefined}
              // Without this the badge folds into the link's accessible name
              // and a screen reader announces "Inbox 3" — a bare number with
              // nothing saying what it counts.
              aria-label={showRollup ? `${box.label}, ${unread} unread` : undefined}
              className={rowClass(active)}
            >
              <div
                className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
                  active ? "bg-accent text-accent-fg shadow-[0_4px_12px_-4px_var(--color-accent)]" : "bg-surface-2 text-muted"
                }`}
              >
                <Icon size={15} />
              </div>
              <span
                className={`min-w-0 flex-1 truncate text-sm ${
                  active ? "font-semibold text-fg" : "text-fg/90"
                }`}
              >
                {box.label}
              </span>
              {showRollup && (
                <span className="rounded-full bg-accent px-1.5 py-0.5 text-[11px] font-semibold text-accent-fg">
                  {unread > 99 ? "99+" : unread}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="flex shrink-0 items-center justify-between border-t border-border/60 px-4 pb-1 pt-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">People</h3>
        {peerId && (
          <Link
            to={{ pathname: LIST_PATH, search: mailSearch(folder) }}
            className="text-[11px] font-medium text-accent hover:underline"
          >
            Show everyone
          </Link>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-0.5 overflow-auto px-2 pb-2">
        {peers.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted">
            No one yet — write your first email with New Mail.
          </p>
        ) : (
          peers.map((p: InboxPeerView) => {
            // Prefers the account resolved by the gateway over the row's own
            // projection, which can lag a rename — and which carries no address
            // at all, because messaging-svc has never stored one.
            const { name, email } = peerLabel(p);
            // A peer the user has already opened (or one with nothing unviewed)
            // shows no badge. The cache is patched to unreadCount=0 the moment
            // that peer's feed mounts (see lib/useMarkPeerRead) so this toggles
            // immediately on click — no server round-trip needed for the UX.
            return (
              <Link
                key={p.peerId}
                to={{ pathname: LIST_PATH, search: mailSearch(folder, p.peerId) }}
                aria-current={p.peerId === peerId ? "page" : undefined}
                // Same reason as the folder rows above: the relative time and
                // the unread count would otherwise be read out as part of the
                // person's name — "Jane Okafor 2m 3".
                aria-label={p.unreadCount > 0 ? `${name}, ${p.unreadCount} unread` : name}
                className={rowClass(p.peerId === peerId)}
              >
                <Avatar name={name} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-fg">{name}</span>
                    <span className="shrink-0 text-[10px] text-muted">
                      {relative(p.lastEventAt)}
                    </span>
                  </div>
                  {/* Only the gateway supplies an address; on the REST path
                      there is none and the row stays a single line. */}
                  {email && <div className="truncate text-[11px] text-muted">{email}</div>}
                </div>
                {p.unreadCount > 0 && (
                  <span className="shrink-0 rounded-full bg-accent px-1.5 text-[11px] font-semibold text-accent-fg">
                    {p.unreadCount}
                  </span>
                )}
              </Link>
            );
          })
        )}
      </div>

      <p className="shrink-0 border-t border-border/60 px-4 py-2 text-[11px] text-muted">
        <Users size={11} className="mr-1 inline align-[-1px]" />
        Chats live in Chats, tasks in Tasks.
      </p>
    </>
  );
}
