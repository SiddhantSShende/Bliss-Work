import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bell, BellOff, MessageSquarePlus, MoreVertical, Pin, Plus, Search, Trash2 } from "lucide-react";
import { Avatar, EmptyState } from "@taskboard/ui";
import type { ConversationDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { displayNameOf, useUserLabels } from "../lib/userLabel";
import { ListHeader, rowClass, relTime } from "../features/ListPane";
import { NewChatDialog } from "../features/NewChatDialog";
import { usePresence } from "../lib/usePresence";
import { toggleConversationPref, useConversationPrefs } from "../lib/conversationPrefs";
import { usePopupDismiss } from "../lib/usePopupDismiss";
import { useSelectedChat } from "../lib/selectedChat";
import { listPreview } from "../lib/chatEnvelope";
import { ConfirmDialog } from "../features/ConfirmDialog";

function ChatListMenu({
  muted,
  pinned,
  onToggleMute,
  onTogglePin,
  onDelete,
}: {
  muted: boolean;
  pinned: boolean;
  onToggleMute: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const wrap = usePopupDismiss<HTMLDivElement>(open, close);
  const pick = (run: () => void) => (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    close();
    run();
  };

  return (
    <div ref={wrap} className="relative shrink-0" onClick={(event) => event.stopPropagation()}>
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
        // The click-away backdrop this used to carry covered the whole app at
        // z-[999], so opening one row's menu made every other row — and the
        // chat list itself — unclickable until you had spent a click closing
        // it. usePopupDismiss closes on an outside click without a layer in the
        // way, and closes any other popup that was open.
        <div
          role="menu"
          aria-label="Chat options"
          className="absolute right-0 z-[1000] mt-1.5 w-52 rounded-xl border border-border bg-surface p-1 shadow-card"
        >
          <ChatListMenuItem icon={<Pin size={15} />} label={pinned ? "Unpin Chat" : "Pin Chat"} onClick={pick(onTogglePin)} />
          <ChatListMenuItem
            icon={<Trash2 size={15} />}
            label="Delete Chat"
            onClick={pick(onDelete)}
            danger
          />
          <ChatListMenuItem
            icon={muted ? <Bell size={15} /> : <BellOff size={15} />}
            label={muted ? "Unmute Notifications" : "Mute Notifications"}
            onClick={pick(onToggleMute)}
          />
        </div>
      )}
    </div>
  );
}

function ChatListMenuItem({
  icon,
  label,
  onClick,
  danger = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: (event: React.MouseEvent) => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
        danger ? "text-danger hover:bg-danger/10" : "text-fg hover:bg-surface-2"
      }`}
    >
      <span className={danger ? "" : "text-muted"}>{icon}</span>
      <span className="font-medium">{label}</span>
    </button>
  );
}

export function ChatsList() {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const { selectedId, openChat, closeChat } = useSelectedChat();
  const [newOpen, setNewOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "unread" | "mentions">("all");
  const [deleteTarget, setDeleteTarget] = useState<ConversationDTO | null>(null);
  const { data: conversations = [] } = useQuery({ queryKey: qk.conversations, queryFn: () => api.conversations() });
  // Mute and "add shortcut", set from a chat's own overflow menu, are read back
  // here — this list is the only place either one is observable. Both are
  // device-local; see lib/conversationPrefs.
  const prefs = useConversationPrefs();
  // Presence for the peers on screen, not for the whole organisation — see
  // lib/usePresence. This list is bounded by how many chats a person has.
  const onlineSet = usePresence(conversations.map((c: ConversationDTO) => c.peerId));
  // Peer avatars resolved live rather than trusted from the conversation row —
  // see displayNameOf's docstring on why the embedded copy can lag a change.
  const { avatarUrlOf } = useUserLabels(conversations.map((c: ConversationDTO) => c.peerId));

  // Same two calls DMView's own "Clear Chat" makes from inside the
  // conversation: hide the history for this caller, then drop the
  // conversation off their list. There is no separate "delete" endpoint —
  // clearing and ignoring together is what deleting a 1:1 chat means here.
  const deleteChat = useMutation({
    mutationFn: (conversationId: string) =>
      api.clearConversation(conversationId).then(() => api.ignoreConversation(conversationId)),
    onSuccess: (_result, conversationId) => {
      void qc.invalidateQueries({ queryKey: qk.conversations });
      if (selectedId === conversationId) closeChat();
    },
    onError: () => toast.error("Couldn't delete this chat"),
  });

  // Shortcuts float to the top; everything else keeps the server's order (most
  // recent first). A stable partition rather than a sort, so two pinned chats
  // stay in the order the conversation list already put them in.
  const ordered = useMemo(() => {
    const pinned = conversations.filter((c: ConversationDTO) => prefs.hasShortcut("chat", c.id));
    if (pinned.length === 0) return conversations;
    return [...pinned, ...conversations.filter((c: ConversationDTO) => !prefs.hasShortcut("chat", c.id))];
  }, [conversations, prefs]);

  const visibleChats = useMemo(() => {
    const query = search.trim().toLowerCase();
    return ordered.filter((conversation: ConversationDTO) => {
      const searchableText = `${displayNameOf(conversation)} ${conversation.lastMessage ?? ""}`.toLowerCase();
      const matchesSearch = !query || searchableText.includes(query);
      const matchesFilter =
        filter === "all" ||
        (filter === "unread" && conversation.unread > 0) ||
        (filter === "mentions" && (conversation.lastMessage ?? "").includes("@"));
      return matchesSearch && matchesFilter;
    });
  }, [filter, ordered, search]);

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
      <div className="space-y-2 border-b border-border/60 px-3 py-2">
        <label className="relative block">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="search"
            aria-label="Search chats"
            placeholder="Search chats..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="h-9 w-full rounded-lg border border-border bg-surface-2 pl-9 pr-3 text-sm text-fg outline-none placeholder:text-muted focus:border-accent"
          />
        </label>
        <div className="flex items-center" role="tablist" aria-label="Chat filters">
          {(["all", "unread", "mentions"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              onClick={() => setFilter(value)}
              className={`relative flex-1 px-2 py-1.5 text-xs font-medium capitalize transition-colors ${
                filter === value ? "text-accent after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent" : "text-muted hover:text-fg"
              }`}
            >
              {value}
              {value === "unread" &&
                conversations.filter((conversation: ConversationDTO) => conversation.unread > 0).length > 0 && (
                  <span className="ml-1.5 rounded-full bg-accent px-1.5 text-[10px] text-accent-fg">
                    {conversations.filter((conversation: ConversationDTO) => conversation.unread > 0).length}
                  </span>
                )}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-auto p-2">
        {conversations.length === 0 ? (
          <EmptyState icon={<MessageSquarePlus size={22} />} title="No chats yet" hint="Tap + to start a conversation." />
        ) : visibleChats.length === 0 ? (
          <EmptyState icon={<Search size={22} />} title="No matching chats" hint="Try another search or filter." />
        ) : (
          visibleChats.map((c: ConversationDTO) => {
            const muted = prefs.isMuted("chat", c.id);
            const pinned = prefs.hasShortcut("chat", c.id);
            return (
              // No longer a NavLink: there is no per-chat URL to link to, and
              // "active" is now the selection rather than a route match.
              //
              // Shaped as MembersList shapes its rows — a div carrying the row
              // styling, one button for the row itself and the overflow menu as
              // its SIBLING. The menu is a button, and a button inside a button
              // is invalid markup that React refuses to nest; as an anchor's
              // child it merely got away with it.
              <div key={c.id} className={rowClass(selectedId === c.id)}>
                <button
                  type="button"
                  onClick={() => openChat(c.id)}
                  aria-current={selectedId === c.id ? "true" : undefined}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                <Avatar name={displayNameOf(c)} src={avatarUrlOf(c.peerId)} online={onlineSet.has(c.peerId)} />
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
                    <span className="truncate text-sm text-muted">
                      {c.cleared ? "" : c.lastMessage ? listPreview(c.lastMessage) : "Start chatting"}
                    </span>
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
                </button>
                <ChatListMenu
                  muted={muted}
                  pinned={pinned}
                  onToggleMute={() => toggleConversationPref("muted", "chat", c.id)}
                  onTogglePin={() => toggleConversationPref("shortcut", "chat", c.id)}
                  onDelete={() => setDeleteTarget(c)}
                />
              </div>
            );
          })
        )}
      </div>
      <NewChatDialog open={newOpen} onClose={() => setNewOpen(false)} />
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete chat history?"
        message="This will delete this chat history for you. The other person will keep their copy."
        confirmLabel="Delete chat"
        danger
        busy={deleteChat.isPending}
        onConfirm={() => {
          if (!deleteTarget) return;
          deleteChat.mutate(deleteTarget.id, { onSuccess: () => setDeleteTarget(null) });
        }}
      />
    </>
  );
}
