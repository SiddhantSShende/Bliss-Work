import { useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X, MessageSquare, ChevronLeft, Phone, Video } from "lucide-react";
import { toast } from "sonner";
import { Avatar, Button, EmptyState } from "@taskboard/ui";
import type { ConversationDTO, MessageDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { ChatThread } from "../features/ChatThread";
import { useChatTyping } from "../lib/useChatTyping";
import { useCall } from "../lib/useCall";

export function DMView() {
  const { conversationId = "" } = useParams();
  const { api } = useRuntime();
  const qc = useQueryClient();
  const me = useSession((s) => s.user)!;
  const nav = useNavigate();

  const { data: conversations = [] } = useQuery({ queryKey: qk.conversations, queryFn: () => api.conversations() });
  const conv = conversations.find((c: ConversationDTO) => c.id === conversationId);

  const { data: online = [] } = useQuery({ queryKey: qk.presence, queryFn: () => api.presence(), refetchInterval: 20_000 });
  const isOnline = !!conv && online.includes(conv.peerId);

  const { data: messages = [] } = useQuery({
    queryKey: qk.messages(conversationId),
    queryFn: () => api.messages(conversationId),
    enabled: !!conversationId,
  });

  const { peerTyping, onType, stop: stopTyping } = useChatTyping(conversationId, conv?.peerId);
  const call = useCall();

  useEffect(() => {
    const maxSeq = messages.reduce((m, x) => Math.max(m, x.seq), 0);
    if (maxSeq > 0) api.read(conversationId, maxSeq).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, conversationId]);

  const reply = useMutation({
    mutationFn: (body: string) => api.reply(conversationId, body),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: qk.messages(conversationId) });
      const prev = qc.getQueryData<MessageDTO[]>(qk.messages(conversationId)) ?? [];
      const tempId = `temp:${crypto.randomUUID()}`;
      const seq = prev.reduce((m, x) => Math.max(m, x.seq), 0) + 1;
      const optimistic: MessageDTO = { id: tempId, conversationId, seq, senderId: me.id, body, createdAt: new Date().toISOString() };
      qc.setQueryData<MessageDTO[]>(qk.messages(conversationId), [...prev, optimistic]);
      return { tempId };
    },
    onSuccess: (res, _body, ctx) => {
      qc.setQueryData<MessageDTO[]>(qk.messages(conversationId), (prev) =>
        (prev ?? []).map((m) => (m.id === ctx?.tempId ? { ...m, id: res.messageId, seq: res.seq } : m)),
      );
      qc.invalidateQueries({ queryKey: qk.conversations });
    },
    onError: (_e, _body, ctx) => {
      qc.setQueryData<MessageDTO[]>(qk.messages(conversationId), (prev) => (prev ?? []).filter((m) => m.id !== ctx?.tempId));
      toast.error("Message failed to send");
    },
  });

  const ignore = useMutation({
    mutationFn: () => api.ignoreConversation(conversationId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.conversations });
      nav("/app/chats");
    },
  });

  if (!conv)
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState icon={<MessageSquare size={24} />} title="Conversation not found" hint="Pick another from the sidebar." />
      </div>
    );

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border/70 bg-surface/60 px-5 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <button
            onClick={() => nav("/app/chats")}
            title="Back to chats"
            className="-ml-1 rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg md:hidden"
          >
            <ChevronLeft size={20} />
          </button>
          <Avatar name={conv.peerUsername} online={isOnline} />
          <div className="leading-tight">
            <div className="font-semibold text-fg">{conv.peerUsername}</div>
            <div className={`text-xs ${isOnline ? "text-success" : "text-muted"}`}>{isOnline ? "Online" : "Offline"}</div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" disabled={!isOnline} onClick={() => call.invite(conv.peerId, conv.peerUsername, "audio")} title={isOnline ? "Voice call" : `${conv.peerUsername} is offline`}>
            <Phone size={15} />
          </Button>
          <Button variant="ghost" size="sm" disabled={!isOnline} onClick={() => call.invite(conv.peerId, conv.peerUsername, "video")} title={isOnline ? "Video call" : `${conv.peerUsername} is offline`}>
            <Video size={15} />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => ignore.mutate()} title="Remove from both inboxes">
            <X size={15} /> Ignore
          </Button>
        </div>
      </header>
      <ChatThread
        messages={messages.map((m) => ({ id: m.id, senderId: m.senderId, body: m.body, at: m.createdAt, pending: m.id.startsWith("temp:") }))}
        meId={me.id}
        onSend={(t) => { reply.mutate(t); stopTyping(); }}
        onType={onType}
        peerTyping={peerTyping}
        peerName={conv.peerUsername}
        placeholder={`Message ${conv.peerUsername}…`}
      />
    </div>
  );
}
