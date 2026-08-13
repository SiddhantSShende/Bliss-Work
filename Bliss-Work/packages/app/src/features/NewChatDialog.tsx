import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Search, Users } from "lucide-react";
import { Avatar, Input, EmptyState } from "@taskboard/ui";
import type { UserDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { matchUser, rankUsers } from "../lib/matchUser";
import { Modal } from "./Modal";

export function NewChatDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { api } = useRuntime();
  const me = useSession((s) => s.user)!;
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  const { data: users = [] } = useQuery({ queryKey: qk.directory, queryFn: () => api.directory() });
  useEffect(() => {
    if (open) setQ("");
  }, [open]);

  const results = rankUsers(users.filter((u) => u.id !== me.id && matchUser(u, q)), q);

  const start = async (u: UserDTO) => {
    setBusy(true);
    try {
      const r = await api.sendMessage(u.id, `👋 Hi ${u.displayName.split(" ")[0]}!`);
      onClose();
      nav(`/app/chats/${r.conversationId}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="New chat">
      <div className="relative mb-3">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <Input className="pl-9" placeholder="Search people…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </div>
      <div className="max-h-72 overflow-auto">
        {results.length === 0 ? (
          <EmptyState icon={<Users size={20} />} title="No people found" />
        ) : (
          <div className="space-y-0.5">
            {results.map((u) => (
              <button
                key={u.id}
                disabled={busy}
                onClick={() => start(u)}
                className="flex w-full items-center gap-3 rounded-xl p-2 text-left transition-colors hover:bg-surface-2 disabled:opacity-50"
              >
                <Avatar name={u.displayName} />
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
