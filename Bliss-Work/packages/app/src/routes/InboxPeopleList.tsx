import { Link, NavLink, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { PenSquare, Inbox as InboxIcon, Users } from "lucide-react";
import { Avatar, EmptyState } from "@taskboard/ui";
import type { InboxPeerDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { INBOX_KINDS } from "../lib/inboxKinds";
import { ListHeader, rowClass } from "../features/ListPane";
import { relative } from "../lib/chatFormat";

/**
 * Middle pane of /app/inbox — the People sidebar. Lists every counterparty the
 * user has exchanged mail with (newest activity first), plus an "All" entry
 * that shows the full feed.
 *
 * "New Mail" ROUTES rather than opening a dialog. Composing an email is not a
 * two-field confirmation — it is To/Cc/Bcc, a subject, a body and attachments —
 * and a modal that size covers the very list the user is addressing from. The
 * composer takes the main pane, exactly where the mail being replaced would
 * have been read.
 *
 * Selecting a person routes to /app/inbox/p/:peerId, which filters the right
 * pane (InboxFeed) to just that person's items.
 */
export function InboxPeopleList() {
  const { api } = useRuntime();
  const loc = useLocation();

  const { data: peers = [] } = useQuery({
    queryKey: qk.inboxPeers,
    queryFn: () => api.inboxPeers(INBOX_KINDS),
  });

  // "All" is active both at the index route and the explicit /all route.
  const allActive = loc.pathname === "/app/inbox" || loc.pathname === "/app/inbox/all";

  return (
    <>
      <ListHeader
        title="Inbox"
        action={
          <Link
            to="/app/inbox/compose"
            title="New Mail — compose an email"
            className="flex h-8 items-center gap-1.5 rounded-xl bg-gradient-to-br from-brand-from to-brand-to px-3 text-xs font-semibold text-accent-fg shadow-soft transition hover:brightness-105"
          >
            <PenSquare size={14} /> New Mail
          </Link>
        }
      />
      <div className="min-h-0 flex-1 space-y-0.5 overflow-auto p-2">
        {/* "All" — every email, across everyone. */}
        <Link to="/app/inbox/all" className={rowClass(allActive)}>
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-soft text-accent">
            <InboxIcon size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <span className="font-medium text-fg">All</span>
            <div className="truncate text-xs text-muted">Every email you sent &amp; received</div>
          </div>
        </Link>

        {peers.length === 0 ? (
          <EmptyState
            icon={<Users size={22} />}
            title="No conversations yet"
            hint="Write your first email with New Mail."
          />
        ) : (
          peers.map((p: InboxPeerDTO) => {
            const name = p.displayName ?? p.username ?? "Unknown user";
            // A peer the user has already opened (or one with nothing
            // unviewed) shows no badge. The cache is patched to unreadCount=0
            // the moment the InboxFeed for this peer mounts (see that file)
            // so this branch toggles immediately on click — no server round-
            // trip needed for the UX.
            const showBadge = p.unreadCount > 0;
            return (
              <NavLink
                key={p.peerId}
                to={`/app/inbox/p/${p.peerId}`}
                className={({ isActive }) => rowClass(isActive)}
              >
                <Avatar name={name} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium text-fg">{name}</span>
                    <span className="shrink-0 text-[10px] text-muted">
                      {relative(p.lastEventAt)}
                    </span>
                  </div>
                  {showBadge && (
                    <div className="mt-0.5 flex justify-end">
                      <span className="shrink-0 rounded-full bg-accent px-1.5 text-[11px] font-semibold text-accent-fg">
                        {p.unreadCount}
                      </span>
                    </div>
                  )}
                </div>
              </NavLink>
            );
          })
        )}
      </div>
    </>
  );
}
