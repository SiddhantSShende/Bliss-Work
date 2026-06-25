import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Search, Users } from "lucide-react";
import { Avatar, EmptyState, Input } from "@taskboard/ui";
import type { ConversationDTO, UserDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { matchUser, rankUsers } from "../lib/matchUser";
import { ListHeader, rowClass } from "../features/ListPane";

/** Org directory: every teammate, searchable, click to open/start a DM. */
export function MembersList() {
  const { api } = useRuntime();
  const me = useSession((s) => s.user)!;
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  const { data: users = [] } = useQuery({ queryKey: qk.directory, queryFn: () => api.directory() });
  const { data: conversations = [] } = useQuery({ queryKey: qk.conversations, queryFn: () => api.conversations() });
  const { data: online = [] } = useQuery({ queryKey: qk.presence, queryFn: () => api.presence(), refetchInterval: 20_000 });

  const onlineSet = new Set(online);
  const convByPeer = new Map(conversations.map((c: ConversationDTO) => [c.peerId, c.id] as [string, string]));
  const results = rankUsers(users.filter((u) => u.id !== me.id && matchUser(u, q)), q);

  const open = async (u: UserDTO) => {
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
      <ListHeader title="Members" />
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
            <button
              key={u.id}
              disabled={busy}
              onClick={() => open(u)}
              className={`w-full ${rowClass(false)} disabled:opacity-50`}
            >
              <Avatar name={u.displayName} online={onlineSet.has(u.id)} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-fg">{u.displayName}</div>
                <div className="truncate text-sm text-muted">
                  {onlineSet.has(u.id) ? "Online" : `@${u.username}`}
                </div>
              </div>
            </button>
          ))
        )}
      </div>
    </>
  );
}
