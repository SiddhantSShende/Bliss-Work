import { useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus, Inbox as InboxIcon, Users } from "lucide-react";
import { Avatar, EmptyState } from "@taskboard/ui";
import type { InboxPeerDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { ListHeader, rowClass } from "../features/ListPane";
import { relative } from "../lib/chatFormat";
import { ComposeDialog } from "../features/ComposeDialog";

/**
 * Middle pane of /app/inbox — the People sidebar. Lists every counterparty the
 * user has exchanged messages/tasks with (newest activity first), plus an "All"
 * entry that shows the full feed. The Compose (+) button opens ComposeDialog.
 *
 * Selecting a person routes to /app/inbox/p/:peerId, which filters the right
 * pane (InboxFeed) to just that person's items.
 */
export function InboxPeopleList() {
  const { api } = useRuntime();
  const loc = useLocation();
  const [composeOpen, setComposeOpen] = useState(false);

  const { data: peers = [] } = useQuery({ queryKey: qk.inboxPeers, queryFn: () => api.inboxPeers() });

  // "All" is active both at the index route and the explicit /all route.
  const allActive = loc.pathname === "/app/inbox" || loc.pathname === "/app/inbox/all";

  return (
    <>
      <ListHeader
        title="Inbox"
        action={
          <button
            onClick={() => setComposeOpen(true)}
            title="Compose — message or task"
            className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-brand-from to-brand-to text-accent-fg shadow-soft transition hover:brightness-105"
          >
            <Plus size={16} />
          </button>
        }
      />
      <div className="min-h-0 flex-1 space-y-0.5 overflow-auto p-2">
        {/* "All" — every message & task across everyone. */}
        <Link to="/app/inbox/all" className={rowClass(allActive)}>
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-soft text-accent">
            <InboxIcon size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <span className="font-medium text-fg">All</span>
            <div className="truncate text-xs text-muted">Every message &amp; task</div>
          </div>
        </Link>

        {peers.length === 0 ? (
          <EmptyState
            icon={<Users size={22} />}
            title="No conversations yet"
            hint="Tap + to message someone or assign a task."
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
      <ComposeDialog open={composeOpen} onClose={() => setComposeOpen(false)} />
    </>
  );
}
