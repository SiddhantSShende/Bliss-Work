import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, MessageSquare, Search, Users } from "lucide-react";
import { Avatar, EmptyState, Input } from "@taskboard/ui";
import type { ConversationDTO, MemberActivityDTO, UserDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { matchUser, rankUsers } from "../lib/matchUser";
import { ListHeader, rowClass } from "../features/ListPane";
import { ActivityNotice } from "../features/ActivityNotice";

/** Org directory: every teammate, searchable. The row opens their profile;
 *  the chat icon keeps the one-click "start a DM" this list has always been the
 *  fastest route to — sending people through a detail page first would have
 *  made the app's primary messaging entry point two clicks slower. */
export function MembersList() {
  const { api } = useRuntime();
  const me = useSession((s) => s.user)!;
  const nav = useNavigate();
  const { userId } = useParams();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  const { data: users = [] } = useQuery({ queryKey: qk.directory, queryFn: () => api.directory() });
  const { data: conversations = [] } = useQuery({ queryKey: qk.conversations, queryFn: () => api.conversations() });
  const { data: online = [] } = useQuery({ queryKey: qk.presence, queryFn: () => api.presence(), refetchInterval: 20_000 });
  // Admins additionally get idle-vs-online and a last-seen time, which raw
  // presence cannot answer: a socket stays open while someone is away from the
  // keyboard, so presence alone reports "online" for an empty chair.
  const isAdmin = me.roles.includes("org_admin");
  const { data: activity = [] } = useQuery({
    queryKey: qk.activityRoster,
    queryFn: () => api.memberActivity(),
    enabled: isAdmin,
    refetchInterval: 60_000,
  });

  const onlineSet = new Set(online);
  const activityById = new Map(activity.map((a) => [a.userId, a]));
  const convByPeer = new Map(conversations.map((c: ConversationDTO) => [c.peerId, c.id] as [string, string]));
  const results = rankUsers(users.filter((u) => u.id !== me.id && matchUser(u, q)), q);

  const message = async (u: UserDTO) => {
    const existing = convByPeer.get(u.id);
    if (existing) return nav(`/app/chats/${existing}`);
    setBusy(true);
    try {
      const r = await api.sendMessage(u.id, `👋 Hi ${u.displayName.split(" ")[0]}!`);
      nav(`/app/chats/${r.conversationId}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ListHeader
        title="Members"
        action={
          isAdmin ? (
            <button
              onClick={() => nav("/app/members/activity")}
              title="Workspace activity"
              aria-label="Workspace activity"
              className="rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <BarChart3 size={17} />
            </button>
          ) : undefined
        }
      />
      <ActivityNotice />
      <div className="px-2 pt-2">
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <Input className="h-9 pl-9" placeholder="Search teammates…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-auto p-2">
        {results.length === 0 ? (
          <EmptyState icon={<Users size={22} />} title="No teammates found" />
        ) : (
          results.map((u) => (
            <div key={u.id} className={`group ${rowClass(u.id === userId)}`}>
              <button
                onClick={() => nav(`/app/members/${u.id}`)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                <Avatar name={u.displayName} online={onlineSet.has(u.id)} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-fg">{u.displayName}</div>
                  <div className="truncate text-sm text-muted">
                    {statusLine(u.username, onlineSet.has(u.id), activityById.get(u.id))}
                  </div>
                </div>
              </button>
              <button
                onClick={() => message(u)}
                disabled={busy}
                title={`Message ${u.displayName}`}
                aria-label={`Message ${u.displayName}`}
                className="shrink-0 rounded-lg p-2 text-muted opacity-0 transition hover:bg-surface-2 hover:text-accent focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-50 md:opacity-60"
              >
                <MessageSquare size={16} />
              </button>
            </div>
          ))
        )}
      </div>
    </>
  );
}

/**
 * The one line under a name. Three states, not two.
 *
 * Presence (from the gateway socket) answers "is a tab open"; the activity
 * record answers "are they at the keyboard". Reporting the second is the whole
 * reason it exists — a laptop left open overnight is "online" to the socket and
 * idle to anyone who cares. Members without the admin roster fall back to the
 * plain online/@username line they have always seen.
 */
function statusLine(
  username: string,
  socketOpen: boolean,
  activity: MemberActivityDTO | undefined,
): string {
  if (!activity) return socketOpen ? "Online" : `@${username}`;
  if (activity.state === "online") return "Online";
  if (activity.state === "idle") return "Idle";
  if (!activity.lastSeenAt) return `@${username}`;
  return `Last seen ${relativeTime(activity.lastSeenAt)}`;
}

function relativeTime(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}
