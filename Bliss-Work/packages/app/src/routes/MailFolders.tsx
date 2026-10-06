import { Link, useSearchParams } from "react-router-dom";
import {
  FileEdit,
  Inbox as InboxIcon,
  Send,
  Star,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useInboxPeers } from "../lib/useInboxPeers";
import { ListHeader, NavIconTile, rowClass } from "../features/ListPane";
import { MAIL_FOLDERS, type MailFolder, mailSearch, folderOf, peerOf, folderLabel } from "../lib/mailView";

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
  favorites: Star,
};

/**
 * Mail's first container: the folders, and the people underneath them.
 *
 * This is the column the app shell puts beside the rail, and the only place the
 * folder itself is chosen. Two things stacked:
 *   Folders — Inbox, Sent Items, Drafts, Deleted Items and Spam, written into
 *             the URL as ?box= so the message list and the reading pane both
 *             see the same choice. Four of them list real mail, each from a
 *             different source; Spam is the one with nothing behind it and says
 *             why (see lib/mailView) rather than looking like a listing that
 *             failed to load.
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
  const { t } = useTranslation("mail");
  const [params] = useSearchParams();
  const folder = folderOf(params);
  const peerId = peerOf(params);

  const { data: peers = [] } = useInboxPeers();
  const unread = peers.reduce((sum, p) => sum + (p.unreadCount || 0), 0);

  return (
    <>
      <ListHeader title={t("folders.title")} />

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
              aria-label={
                showRollup
                  ? t("folders.unreadAriaLabel", { folder: folderLabel(box.key), count: unread })
                  : undefined
              }
              className={rowClass(active)}
            >
              <NavIconTile>
                <Icon size={15} />
              </NavIconTile>
              <span
                className={`min-w-0 flex-1 truncate text-sm font-semibold ${
                  active ? "text-fg" : "text-fg/90"
                }`}
              >
                {folderLabel(box.key)}
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

    </>
  );
}
