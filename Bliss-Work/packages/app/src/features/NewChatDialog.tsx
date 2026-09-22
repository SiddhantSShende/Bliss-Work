import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Search, Users } from "lucide-react";
import { toast } from "sonner";
import { Avatar, Input, EmptyState } from "@taskboard/ui";
import type { UserDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { matchUser, rankUsers } from "../lib/matchUser";
import { useSelectedChat } from "../lib/selectedChat";
import { Modal } from "./Modal";

export function NewChatDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation("chatList");
  const { api } = useRuntime();
  const qc = useQueryClient();
  const me = useSession((s) => s.user)!;
  const nav = useNavigate();
  const { openChat } = useSelectedChat();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  const { data: users = [] } = useQuery({ queryKey: qk.directory, queryFn: () => api.directory() });
  useEffect(() => {
    if (open) setQ("");
  }, [open]);

  const results = rankUsers(users.filter((u) => u.id !== me.id && matchUser(u, q)), q);

  // Opening a chat must not SAY anything. This used to post "👋 Hi {name}!"
  // because sending was the only way to create a conversation row; openConversation
  // creates it silently. The conversation list is refreshed before navigating
  // because DMView resolves the header from it and would otherwise flash
  // "Conversation not found" for a brand-new, empty chat.
  const start = async (u: UserDTO) => {
    setBusy(true);
    try {
      const { conversationId } = await api.openConversation(u.id);
      await qc.invalidateQueries({ queryKey: qk.conversations });
      onClose();
      // Selects and moves to the section in one step, so a brand-new chat's id
      // never reaches the URL — see lib/selectedChat.
      openChat(conversationId);
    } catch {
      toast.error(t("newChat.errorToast.title"), { description: t("newChat.errorToast.description") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t("newChat.title")}>
      <div className="relative mb-3">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <Input className="pl-9" placeholder={t("newChat.searchPlaceholder")} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </div>
      <div className="max-h-72 overflow-auto">
        {results.length === 0 ? (
          <EmptyState icon={<Users size={20} />} title={t("newChat.emptyTitle")} />
        ) : (
          <div className="space-y-0.5">
            {results.map((u) => (
              <button
                key={u.id}
                disabled={busy}
                onClick={() => start(u)}
                className="flex w-full items-center gap-3 rounded-xl p-2 text-left transition-colors hover:bg-surface-2 disabled:opacity-50"
              >
                <Avatar name={u.displayName} src={u.avatarUrl} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-fg">{u.displayName}</div>
                  <div className="truncate text-xs text-muted">@{u.username}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
