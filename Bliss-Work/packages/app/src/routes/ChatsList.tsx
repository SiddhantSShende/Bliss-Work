import { useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Bell, BellOff, MessageSquarePlus, MoreVertical, Pin, Plus, Trash2 } from "lucide-react";
import { Avatar, EmptyState } from "@taskboard/ui";
import type { ConversationDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { displayNameOf } from "../lib/userLabel";
import { ListHeader, rowClass, relTime } from "../features/ListPane";
import { NewChatDialog } from "../features/NewChatDialog";
import { usePresence } from "../lib/usePresence";
import { toggleConversationPref, useConversationPrefs } from "../lib/conversationPrefs";

const UNAVAILABLE_HINT = "Not available yet — needs a server endpoint";

function ChatListMenu({
  muted,
  pinned,
  onToggleMute,
  onTogglePin,
}: {
  muted: boolean;
  pinned: boolean;
  onToggleMute: () => void;
  onTogglePin: () => void;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const pick = (run: () => void) => (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    close();
    run();
  };

  return (
    <div className="relative shrink-0" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        title="Chat options"
        aria-label="Chat options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.preventDefault();
          setOpen((value) => !value);
        }}
        className="flex items-center rounded-lg px-1.5 py-1 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
      >
        <MoreVertical size={16} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[999]" onClick={close} aria-hidden />
          <div
            role="menu"
            aria-label="Chat options"
            className="absolute right-0 z-[1000] mt-1.5 w-52 rounded-xl border border-border bg-surface p-1 shadow-card"
          >
            <ChatListMenuItem icon={<Pin size={15} />} label={pinned ? "Unpin Chat" : "Pin Chat"} onClick={pick(onTogglePin)} />
            <ChatListMenuItem
              icon={<Trash2 size={15} />}
              label="Delete Chat"
              hint={UNAVAILABLE_HINT}
              danger
            />
            <ChatListMenuItem
              icon={muted ? <Bell size={15} /> : <BellOff size={15} />}
              label={muted ? "Unmute Notifications" : "Mute Notifications"}
              onClick={pick(onToggleMute)}
            />
          </div>
        </>
      )}
    </div>
  );
}

function ChatListMenuItem({
  icon,
  label,
  onClick,
  hint,
  danger = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: (event: React.MouseEvent) => void;
  hint?: string;
  danger?: boolean;
}) {
  const item = (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={!onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors disabled:pointer-events-none disabled:opacity-45 ${
        danger ? "text-danger hover:bg-danger/10" : "text-fg hover:bg-surface-2"
      }`}
    >
      <span className={danger ? "" : "text-muted"}>{icon}</span>
      <span className="font-medium">{label}</span>
    </button>
  );
  return onClick || !hint ? item : <span title={hint}>{item}</span>;
}

export function ChatsList() {
  const { api } = useRuntime();
  const [newOpen, setNewOpen] = useState(false);
  const { data: conversations = [] } = useQuery({ queryKey: qk.conversations, queryFn: () => api.conversations() });
  // Mute and "add shortcut", set from a chat's own overflow menu, are read back
  // here — this list is the only place either one is observable. Both are
  // device-local; see lib/conversationPrefs.
  const prefs = useConversationPrefs();
  // Presence for the peers on screen, not for the whole organisation — see
  // lib/usePresence. This list is bounded by how many chats a person has.
  const onlineSet = usePresence(conversations.map((c: ConversationDTO) => c.peerId));

  // Shortcuts float to the top; everything else keeps the server's order (most
  // recent first). A stable partition rather than a sort, so two pinned chats
  // stay in the order the conversation list already put them in.
  const ordered = useMemo(() => {
    const pinned = conversations.filter((c: ConversationDTO) => prefs.hasShortcut("chat", c.id));
    if (pinned.length === 0) return conversations;
    return [...pinned, ...conversations.filter((c: ConversationDTO) => !prefs.hasShortcut("chat", c.id))];
  }, [conversations, prefs]);

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
          ordered.map((c: ConversationDTO) => {
            const muted = prefs.isMuted("chat", c.id);
            const pinned = prefs.hasShortcut("chat", c.id);
            return (
              <NavLink key={c.id} to={`/app/chats/${c.id}`} className={({ isActive }) => rowClass(isActive)}>
                <Avatar name={displayNameOf(c)} online={onlineSet.has(c.peerId)} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium text-fg">{displayNameOf(c)}</span>
                    <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted">
                      {prefs.hasShortcut("chat", c.id) && (
                        <Pin size={11} aria-label="Pinned" className="text-accent" />
                      )}
                      {muted && <BellOff size={11} aria-label="Muted" />}
                      {relTime(c.lastMessageAt)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm text-muted">{c.lastMessage ?? "Start chatting"}</span>
                    {c.unread > 0 && (
                      // A muted chat still says how much is waiting; it just
                      // stops asking for attention while it does. That is the
                      // whole of what muting can mean here — nothing else in
                      // the app raises a notification for a message.
                      <span
                        className={`shrink-0 rounded-full px-1.5 text-[11px] font-semibold ${
                          muted ? "bg-surface-2 text-muted" : "bg-accent text-accent-fg"
                        }`}
                      >
                        {c.unread}
                      </span>
                    )}
                  </div>
                </div>
                <ChatListMenu
                  muted={muted}
                  pinned={pinned}
                  onToggleMute={() => toggleConversationPref("muted", "chat", c.id)}
                  onTogglePin={() => toggleConversationPref("shortcut", "chat", c.id)}
                />
              </NavLink>
            );
          })
        )}
      </div>
      <NewChatDialog open={newOpen} onClose={() => setNewOpen(false)} />
    </>
  );
}
