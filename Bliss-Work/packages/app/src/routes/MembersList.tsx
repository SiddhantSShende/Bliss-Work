import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, MessageSquare, Search, Users } from "lucide-react";
import { Avatar, EmptyState, Input } from "@taskboard/ui";
import type { ConversationDTO, MemberActivityDTO, UserDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { matchUser, rankUsers } from "../lib/matchUser";
import { relativeTime } from "../lib/relativeTime";
import { ListHeader, rowClass } from "../features/ListPane";
import { ActivityNotice } from "../features/ActivityNotice";
import { usePresence } from "../lib/usePresence";

/** Org directory: every teammate, searchable. The row opens their profile;
 *  the chat icon keeps the one-click "start a DM" this list has always been the
 *  fastest route to — sending people through a detail page first would have
 *  made the app's primary messaging entry point two clicks slower. */
export function MembersList() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const me = useSession((s) => s.user)!;
  const nav = useNavigate();
  const { userId } = useParams();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  const { data: users = [] } = useQuery({ queryKey: qk.directory, queryFn: () => api.directory() });
  const { data: conversations = [] } = useQuery({ queryKey: qk.conversations, queryFn: () => api.conversations() });
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

  // Keyed on the loaded directory rather than on `results` below, which is
  // re-derived on every keystroke of the search box — a query key that changed
  // per keystroke would fire a presence request per keystroke.
  //
  // This is the one screen whose list genuinely tracks the size of the
  // organisation, and that is fine now in a way it was not before: usePresence
  // chunks into per-user reads that shard evenly, instead of every screen
  // re-reading one org-wide sorted set on a 20-second timer. See
  // lib/usePresence.
  const onlineSet = usePresence(users.map((u) => u.id));
  const activityById = new Map(activity.map((a) => [a.userId, a]));
  const convByPeer = new Map(conversations.map((c: ConversationDTO) => [c.peerId, c.id] as [string, string]));
  const results = rankUsers(users.filter((u) => u.id !== me.id && matchUser(u, q)), q);

  /**
   * Admins' presence is hidden from ordinary members.
   *
   * Client-side because the roles are already here (the directory query above
   * carries them) and neither service that could enforce it knows who is an
   * admin: telemetry-svc deliberately stores no roles, and the gateway's
   * /presence only knows the CALLER's. Worth being clear that this is therefore
   * a UI convention, not a control — /presence still returns admin ids to any
   * authenticated member who calls it directly.
   *
   * Admins still see each other, or they could not tell who is around to cover.
   */
  const hideStatusFor = (u: UserDTO) => !isAdmin && u.roles.includes("org_admin");

  // Your own row, pinned above the search results.
  //
  // The list filters you out — messaging yourself is meaningless — but that
  // also removed the only route to your own activity record, so an admin could
  // read every colleague's and not their own. MemberDetail already handles the
  // self case (isSelf, the "me" subject id, the self banner); it just had no
  // way in. Hidden while searching unless you actually match the query.
  const meUser = users.find((u) => u.id === me.id);
  const showSelfRow = !!meUser && (!q.trim() || matchUser(meUser, q));

  // Opens the chat without saying anything. This used to post "👋 Hi {name}!"
  // because sending was the only way to create a conversation row.
  const message = async (u: UserDTO) => {
    const existing = convByPeer.get(u.id);
    if (existing) return nav(`/app/chats/${existing}`);
    setBusy(true);
    try {
      const { conversationId } = await api.openConversation(u.id);
      // DMView reads its header from the conversation list, so refresh it before
      // navigating or a brand-new chat flashes "Conversation not found".
      await qc.invalidateQueries({ queryKey: qk.conversations });
      nav(`/app/chats/${conversationId}`);
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
        {showSelfRow && meUser && (
          <button
            onClick={() => nav(`/app/members/${me.id}`)}
            className={`w-full ${rowClass(me.id === userId)} text-left`}
          >
            <Avatar name={meUser.displayName} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-fg">{meUser.displayName} (you)</div>
              <div className="truncate text-sm text-muted">Your activity and sessions</div>
            </div>
          </button>
        )}
        {results.length === 0 && !showSelfRow ? (
          <EmptyState icon={<Users size={22} />} title="No teammates found" />
        ) : (
          results.map((u) => (
            <div key={u.id} className={`group ${rowClass(u.id === userId)}`}>
              <button
                onClick={() => nav(`/app/members/${u.id}`)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                {/* `undefined`, not `false`: Avatar renders NO dot for
                    undefined and a grey "offline" dot for false, and a grey dot
                    still discloses that we are tracking them. */}
                <Avatar
                  name={u.displayName}
                  online={hideStatusFor(u) ? undefined : onlineSet.has(u.id)}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-fg">{u.displayName}</div>
                  <div className="truncate text-sm text-muted">
                    {statusLine(
                      u.username,
                      onlineSet.has(u.id),
                      activityById.get(u.id),
                      hideStatusFor(u),
                    )}
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
 *
 * `hideStatus` collapses all of it to the handle. That is not a new visual
 * state: it is exactly what a member already sees for anyone the activity
 * roster does not cover, so hiding an admin's status makes their row
 * indistinguishable from an ordinary one rather than conspicuously redacted.
 */
function statusLine(
  username: string,
  socketOpen: boolean,
  activity: MemberActivityDTO | undefined,
  hideStatus = false,
): string {
  if (hideStatus) return `@${username}`;
  if (!activity) return socketOpen ? "Online" : `@${username}`;
  if (activity.state === "online") return "Online";
  if (activity.state === "idle") return "Idle";
  if (!activity.lastSeenAt) return `@${username}`;
  return `Last seen ${relativeTime(activity.lastSeenAt)}`;
}

