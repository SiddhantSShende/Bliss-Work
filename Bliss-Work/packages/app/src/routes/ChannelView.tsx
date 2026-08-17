import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Hash, Users, ChevronLeft, LogOut, Lock, Video } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@taskboard/ui";
import type { CallDTO, ChannelDTO, ChannelMessageDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { ChatThread } from "../features/ChatThread";
import { useOlderMessages } from "../lib/useOlderMessages";
import { ChannelMembersSheet } from "../features/ChannelMembersSheet";
import { useChatMedia } from "../features/useChatMedia";
import { ScheduleCallDialog } from "../features/ScheduleCallDialog";
import { CallRoom } from "../features/CallRoomLazy";

export function ChannelView() {
  const { channelId = "" } = useParams();
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [rosterOpen, setRosterOpen] = useState(false);
  const me = useSession((s) => s.user)!;
  const nav = useNavigate();

  // Switching channels must land on the CHAT, never on the previous channel's
  // members sheet. This component is mounted once for the whole
  // `channels/:channelId` route (App.tsx), so React Router reuses it across a
  // param change and every piece of local state — this one included — survives
  // into the next channel unless it is explicitly reset.
  useEffect(() => {
    setRosterOpen(false);
    setScheduleOpen(false);
    // Leaving the route must not leave you silently in the previous
    // channel's call — CallRoom disconnects on unmount.
    setActiveCall(null);
  }, [channelId]);

  const { data: channels = [] } = useQuery({ queryKey: qk.channels, queryFn: () => api.channels() });
  const channel = channels.find((c: ChannelDTO) => c.id === channelId);

  // Newest page only; older pages are prepended into the same flat array so
  // the websocket patches and optimistic sends below are unaffected.
  const { data: messages = [] } = useQuery({
    queryKey: qk.channelMessages(channelId),
    queryFn: () => api.channelMessages(channelId),
    enabled: !!channelId,
  });

  const [scheduleOpen, setScheduleOpen] = useState(false);
  // The call currently open in this view. Held here rather than routed so
  // leaving a call returns you to the conversation you were already in.
  const [activeCall, setActiveCall] = useState<CallDTO | null>(null);

  const { loadOlder, loadingOlder, hasOlder } = useOlderMessages(
    qk.channelMessages(channelId),
    channelId,
    messages,
    (beforeSeq, limit) => api.channelMessages(channelId, beforeSeq, limit),
  );

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
        id: tempId, channelId, seq, senderId: me.id,
        senderUsername: me.username, senderDisplayName: me.displayName,
        body, createdAt: new Date().toISOString(),
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

  // A live call takes over the pane. Showing a video grid and a message list in
  // the same column makes both unusable at this width, and the messages are one
  // click away again the moment the call ends.
  if (activeCall) {
    return <CallRoom call={activeCall} onClose={() => setActiveCall(null)} />;
  }

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
          {/* Channel calls are members-only by construction — there is no
              invite control anywhere in this view because the channel IS the
              guest list, and the server refuses to mint a link for one. */}
          <button
            onClick={() => setScheduleOpen(true)}
            title="Start or schedule a call"
            aria-label="Start or schedule a channel call"
            className="flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <Video size={15} />
          </button>
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
          // senderUsername is the email local-part; the display name is what a
          // reader should see above a channel bubble.
          id: m.id, senderId: m.senderId, senderName: m.senderDisplayName || m.senderUsername,
          body: m.body, at: m.createdAt, kind: m.kind, pending: m.id.startsWith("temp:"),
        }))}
        meId={me.id}
        onLoadOlder={loadOlder}
        loadingOlder={loadingOlder}
        hasOlder={hasOlder}
        // flushStaged, not send.mutate: Send must emit the attachment tray as
        // well as the text, and must tolerate an empty text (attachments only).
        onSend={(t) => media.flushStaged(t)}
        showSenderNames
        placeholder={`Message #${channel.name}…`}
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
      {scheduleOpen && (
        <ScheduleCallDialog
          scope={{ kind: "channel", channelId }}
          onClose={() => setScheduleOpen(false)}
          onStarted={(call) => {
            setScheduleOpen(false);
            setActiveCall(call);
          }}
        />
      )}
    </div>
  );
}
