import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Hash, Users, ChevronLeft, LogOut, Lock } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@taskboard/ui";
import type { ChannelDTO, ChannelMessageDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { ChatThread } from "../features/ChatThread";
import { ChannelMembersSheet } from "../features/ChannelMembersSheet";
import { ForwardDialog } from "../features/ForwardDialog";
import { useChatMedia } from "../features/useChatMedia";

export function ChannelView() {
  const { channelId = "" } = useParams();
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [rosterOpen, setRosterOpen] = useState(false);
  const [forwardMsg, setForwardMsg] = useState<{ id: string; body: string } | null>(null);
  const me = useSession((s) => s.user)!;
  const nav = useNavigate();

  // Switching channels must land on the CHAT, never on the previous channel's
  // members sheet. This component is mounted once for the whole
  // `channels/:channelId` route (App.tsx), so React Router reuses it across a
  // param change and every piece of local state — this one included — survives
  // into the next channel unless it is explicitly reset.
  useEffect(() => {
    setRosterOpen(false);
    setForwardMsg(null);
  }, [channelId]);

  const { data: channels = [] } = useQuery({ queryKey: qk.channels, queryFn: () => api.channels() });
  const channel = channels.find((c: ChannelDTO) => c.id === channelId);

  const { data: messages = [] } = useQuery({
    queryKey: qk.channelMessages(channelId),
    queryFn: () => api.channelMessages(channelId),
    enabled: !!channelId,
  });

  const leave = useMutation({
    mutationFn: () => api.leaveChannel(channelId),
    onSuccess: () => {
      toast.success(`You left #${channel?.name}`);
      void qc.invalidateQueries({ queryKey: qk.channels });
      void qc.invalidateQueries({ queryKey: qk.openChannels });
      nav("/app/channels");
    },
    onError: (e) => toast.error("Couldn't leave", { description: String(e) }),
  });

  const confirmLeave = () => {
    if (!channel) return;
    const ok = window.confirm(
      `Leave #${channel.name}?\n\n${
        channel.isLocked
          ? "This is a locked (invite-only) channel — a member will need to re-invite you to come back."
          : "You can re-join from the Browse tab whenever you want."
      }`,
    );
    if (ok) leave.mutate();
  };

  const send = useMutation({
    mutationFn: (body: string) => api.sendChannelMessage(channelId, body),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: qk.channelMessages(channelId) });
      const prev = qc.getQueryData<ChannelMessageDTO[]>(qk.channelMessages(channelId)) ?? [];
      const tempId = `temp:${crypto.randomUUID()}`;
      const seq = prev.reduce((m, x) => Math.max(m, x.seq), 0) + 1;
      const optimistic: ChannelMessageDTO = {
        id: tempId, channelId, seq, senderId: me.id, senderUsername: me.username, body, createdAt: new Date().toISOString(),
      };
      qc.setQueryData<ChannelMessageDTO[]>(qk.channelMessages(channelId), [...prev, optimistic]);
      return { tempId };
    },
    onSuccess: (res, _body, ctx) => {
      qc.setQueryData<ChannelMessageDTO[]>(qk.channelMessages(channelId), (prev) =>
        (prev ?? []).map((m) => (m.id === ctx?.tempId ? { ...m, id: res.messageId, seq: res.seq } : m)),
      );
      qc.invalidateQueries({ queryKey: qk.channels });
    },
    onError: (_e, _body, ctx) => {
      qc.setQueryData<ChannelMessageDTO[]>(qk.channelMessages(channelId), (prev) => (prev ?? []).filter((m) => m.id !== ctx?.tempId));
      toast.error("Message failed to send");
    },
  });

  // Declared before the early return so the hook order stays stable while a
  // channel is briefly missing. No p2pFallback: WebRTC transfers are 1:1 and
  // have no channel fanout, so oversized files are refused rather than silently
  // delivered to one arbitrary member.
  const media = useChatMedia({
    scope: "channel",
    scopeId: channelId,
    meId: me.id,
    send: (body) => send.mutate(body),
  });

  if (!channel)
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState icon={<Hash size={24} />} title="Channel not found" hint="Pick another from the sidebar." />
      </div>
    );

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border/70 bg-surface/60 px-5 py-3 backdrop-blur">
        {/* min-w-0 + truncate: a long channel name must not push the member
            count and Leave action off the right edge on a narrow window. */}
        <div className="flex min-w-0 items-center gap-2">
          <button
            onClick={() => nav("/app/channels")}
            title="Back to channels"
            className="-ml-1 shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg md:hidden"
          >
            <ChevronLeft size={20} />
          </button>
          {channel.isLocked ? (
            <Lock size={16} className="shrink-0 text-accent" />
          ) : (
            <Hash size={18} className="shrink-0 text-accent" />
          )}
          <span className="truncate font-semibold text-fg">{channel.name}</span>
          {channel.isLocked && (
            <span className="shrink-0 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-muted">
              locked
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {/* The member count has always been here as plain text. It is the
              obvious place to look for "who else is in this channel", so it is
              now the button that answers that — and, for a manager, the way in
              to adding, removing and blocking people. */}
          <button
            onClick={() => setRosterOpen(true)}
            title="Channel members"
            aria-label={`${channel.memberCount} members — view and manage`}
            className="flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <Users size={15} /> {channel.memberCount}
          </button>
          <button
            onClick={confirmLeave}
            disabled={leave.isPending}
            title="Leave channel"
            aria-label="Leave channel"
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-muted transition hover:bg-surface-2 hover:text-danger disabled:opacity-50"
          >
            <LogOut size={13} /> {leave.isPending ? "Leaving…" : "Leave"}
          </button>
        </div>
      </header>
      <ChannelMembersSheet
        open={rosterOpen}
        onClose={() => setRosterOpen(false)}
        channel={channel}
      />
      <ChatThread
        messages={messages.map((m) => ({
          id: m.id, senderId: m.senderId, senderName: m.senderUsername, body: m.body, at: m.createdAt, kind: m.kind, pending: m.id.startsWith("temp:"),
        }))}
        meId={me.id}
        onSend={(t) => send.mutate(t)}
        showSenderNames
        placeholder={`Message #${channel.name}…`}
        onForward={(id) => {
          const msg = messages.find((m: ChannelMessageDTO) => m.id === id);
          setForwardMsg({ id, body: msg?.body ?? "" });
        }}
        renderBody={media.renderBody}
        onAttach={media.onAttach}
        onShareLocation={media.onShareLocation}
        onPaste={media.onPaste}
        dropzone={media.dropzone}
        dragging={media.dragging}
        overlay={media.overlay}
      />
      <input {...media.fileInputProps} />
      <ForwardDialog
        open={!!forwardMsg}
        onClose={() => setForwardMsg(null)}
        sourceMessageId={forwardMsg?.id ?? null}
        preview={forwardMsg?.body}
        scope="channel"
      />
    </div>
  );
}
