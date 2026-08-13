import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X, MessageSquare, ChevronLeft, Phone, Video, Ban } from "lucide-react";
import { toast } from "sonner";
import { Avatar, Button, EmptyState } from "@taskboard/ui";
import type { ConversationDTO, MessageDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { displayNameOf } from "../lib/userLabel";
import { ChatThread } from "../features/ChatThread";
import { ForwardDialog } from "../features/ForwardDialog";
import { useChatMedia } from "../features/useChatMedia";
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

  // The message currently being forwarded (null = dialog closed). Forwarding is
  // available to every org member (each org supplies its own provider credentials).
  const [forwardMsg, setForwardMsg] = useState<{ id: string; body: string } | null>(null);

  // Same route-reuse trap as ChannelView's members sheet: navigating to another
  // conversation keeps this component mounted, so an open Forward dialog would
  // follow the user into the next chat still holding the old message id.
  useEffect(() => {
    setForwardMsg(null);
  }, [conversationId]);

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

  // Block / unblock toggles the caller's own block on the peer. The WS
  // conversation.blocked/unblocked echo (queryBridge) reconciles both sides;
  // we also invalidate here so the actor's UI flips without waiting on it.
  const block = useMutation({
    mutationFn: () => {
      if (!conv) return Promise.resolve();
      return conv.blockedByMe ? api.unblockUser(conv.peerId) : api.blockUser(conv.peerId);
    },
    onSuccess: (_data, _vars, _ctx) => {
      void qc.invalidateQueries({ queryKey: qk.conversations });
    },
    onError: () =>
      toast.error("Couldn't update block", { description: "Please try again." }),
  });

  // Declared before the early return below so the hook order never changes
  // when a conversation is briefly missing mid-navigation.
  //
  // No p2pFallback here: the peer-to-peer path posts its offer through
  // replyToThread, and this surface works in conversations rather than threads.
  // Files over the server limit are refused with a clear message instead.
  const media = useChatMedia({
    scope: "conversation",
    scopeId: conversationId,
    meId: me.id,
    send: (body) => reply.mutate(body),
  });

  if (!conv)
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState icon={<MessageSquare size={24} />} title="Conversation not found" hint="Pick another from the sidebar." />
      </div>
    );
  
  // Calls require the peer to have a live socket (ws-gateway rejects an offline
  // callee with rtc.peer.unreachable). Rather than silently disable the buttons,
  // let the click through and surface a clear note when the peer is offline.
  const isBlocked = conv.blockedByMe || conv.blockedByPeer;
  // Never render peerUsername directly — it is the email local-part.
  const peerName = displayNameOf(conv);
  const startCall = (media: "audio" | "video") => {
    if (isBlocked) {
      toast("Can't start call", {
        description: conv.blockedByMe
          ? "Unblock this user to call them."
          : "You can't call this user.",
      });
      return;
    }
    if (!isOnline) {
      toast("Can't start call", {
        description: `${peerName} must be online to receive a call.`,
      });
      return;
    }
    call.invite(conv.peerId, peerName, media);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border/70 bg-surface/60 px-5 py-3 backdrop-blur">
        {/* min-w-0 + truncate: without them a long username pushes the call and
            block buttons off the right edge on a narrow window. */}
        <div className="flex min-w-0 items-center gap-3">
          <button
            onClick={() => nav("/app/chats")}
            title="Back to chats"
            className="-ml-1 shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg md:hidden"
          >
            <ChevronLeft size={20} />
          </button>
          <Avatar name={peerName} online={isOnline} />
          <div className="min-w-0 leading-tight">
            <div className="truncate font-semibold text-fg">{peerName}</div>
            <div className={`text-xs ${isOnline ? "text-success" : "text-muted"}`}>{isOnline ? "Online" : "Offline"}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => startCall("audio")} title="Voice call">
            <Phone size={15} />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => startCall("video")} title="Video call">
            <Video size={15} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => block.mutate()}
            disabled={block.isPending}
            title={conv.blockedByMe ? "Unblock this user" : "Block this user"}
          >
            <Ban size={15} /> {conv.blockedByMe ? "Unblock" : "Block"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => ignore.mutate()} title="Remove from both inboxes">
            <X size={15} /> Ignore
          </Button>
        </div>
      </header>
      <ChatThread
        messages={messages.map((m) => ({
          id: m.id, senderId: m.senderId, body: m.body, at: m.createdAt, kind: m.kind,
          status: m.status, pending: m.id.startsWith("temp:"),
        }))}
        meId={me.id}
        // flushStaged, not reply.mutate: Send must emit the attachment tray as
        // well as the text, and must tolerate an empty text (attachments only).
        onSend={(t) => { media.flushStaged(t); stopTyping(); }}
        onType={onType}
        peerTyping={peerTyping}
        peerName={peerName}
        placeholder={`Message ${peerName}…`}
        disabled={isBlocked}
        notice={
          conv.blockedByMe
            ? "You blocked this user. Unblock to send messages."
            : conv.blockedByPeer
              ? "You have been blocked."
              : undefined
        }
        onForward={(id) => {
          const msg = messages.find((m) => m.id === id);
          setForwardMsg({ id, body: msg?.body ?? "" });
        }}
        renderBody={media.renderBody}
        onAttach={media.onAttach}
        onShareLocation={media.onShareLocation}
        onPaste={media.onPaste}
        dropzone={media.dropzone}
        dragging={media.dragging}
        attachments={media.staged}
        onRemoveAttachment={media.removeStaged}
        uploading={Object.keys(media.uploads).length}
        overlay={media.overlay}
      />
      <input {...media.fileInputProps} />
      <ForwardDialog
        open={!!forwardMsg}
        onClose={() => setForwardMsg(null)}
        sourceMessageId={forwardMsg?.id ?? null}
        preview={forwardMsg?.body}
      />
    </div>
  );
}
