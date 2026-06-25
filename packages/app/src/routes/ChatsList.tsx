import { useState } from "react";
import { NavLink } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus, MessageSquarePlus } from "lucide-react";
import { Avatar, EmptyState } from "@taskboard/ui";
import type { ConversationDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { ListHeader, rowClass, relTime } from "../features/ListPane";
import { NewChatDialog } from "../features/NewChatDialog";

export function ChatsList() {
  const { api } = useRuntime();
  const [newOpen, setNewOpen] = useState(false);
  const { data: conversations = [] } = useQuery({ queryKey: qk.conversations, queryFn: () => api.conversations() });
  const { data: online = [] } = useQuery({ queryKey: qk.presence, queryFn: () => api.presence(), refetchInterval: 20_000 });
  const onlineSet = new Set(online);

  return (
    <>
      <ListHeader
        title="Chats"
        action={
          <button
            onClick={() => setNewOpen(true)}
            title="New chat"
            className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-brand-from to-brand-to text-accent-fg shadow-soft transition hover:brightness-105"
          >
            <Plus size={16} />
          </button>
        }
      />
      <div className="min-h-0 flex-1 space-y-0.5 overflow-auto p-2">
        {conversations.length === 0 ? (
          <EmptyState icon={<MessageSquarePlus size={22} />} title="No chats yet" hint="Tap + to start a conversation." />
        ) : (
          conversations.map((c: ConversationDTO) => (
            <NavLink key={c.id} to={`/app/chats/${c.id}`} className={({ isActive }) => rowClass(isActive)}>
              <Avatar name={c.peerUsername} online={onlineSet.has(c.peerId)} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium text-fg">{c.peerUsername}</span>
                  <span className="shrink-0 text-[10px] text-muted">{relTime(c.lastMessageAt)}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm text-muted">{c.lastMessage ?? "Start chatting"}</span>
                  {c.unread > 0 && (
                    <span className="shrink-0 rounded-full bg-accent px-1.5 text-[11px] font-semibold text-accent-fg">{c.unread}</span>
                  )}
                </div>
              </div>
            </NavLink>
          ))
        )}
      </div>
      <NewChatDialog open={newOpen} onClose={() => setNewOpen(false)} />
    </>
  );
}
