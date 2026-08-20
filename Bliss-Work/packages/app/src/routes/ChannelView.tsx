import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Hash, Users, ChevronLeft, Lock } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@taskboard/ui";
import type { CallDTO, ChannelDTO, ChannelMessageDTO, ReactionDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { ChatThread } from "../features/ChatThread";
import { useOlderMessages } from "../lib/useOlderMessages";
import { ChannelMembersSheet } from "../features/ChannelMembersSheet";
import { useWhatsAppForward } from "../lib/useWhatsAppForward";
import { ForwardToDialog } from "../features/ForwardToDialog";
import { useChatMedia } from "../features/useChatMedia";
import { ScheduleCallDialog } from "../features/ScheduleCallDialog";
import { CallMenu } from "../features/CallMenu";
import { ConversationMenu } from "../features/ConversationMenu";
import { ChatSearchBar } from "../features/ChatSearchBar";
import { ChatAssetsSheet } from "../features/ChatAssetsSheet";
import { searchMessages } from "../lib/chatSearch";
import { exportChatTranscript } from "../lib/chatExport";
import { toggleConversationPref, useConversationPrefs } from "../lib/conversationPrefs";
import { useMeetingSession } from "../lib/MeetingSession";

export function ChannelView() {
  const { channelId = "" } = useParams();
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [rosterOpen, setRosterOpen] = useState(false);
  // The header's overflow menu opens these three: an inline search over the
  // loaded messages, the shared-files panel, and nothing else that needs state.
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [assetsOpen, setAssetsOpen] = useState(false);
  const recordForward = useWhatsAppForward();
  // The message being forwarded to another chat or channel (null = closed).
  const [forwardTo, setForwardTo] = useState<{ id: string; body: string } | null>(null);
  const me = useSession((s) => s.user)!;
  const nav = useNavigate();

  // Switching channels must land on the CHAT, never on the previous channel's
  // members sheet. This component is mounted once for the whole
  // `channels/:channelId` route (App.tsx), so React Router reuses it across a
  // param change and every piece of local state — this one included — survives
  // into the next channel unless it is explicitly reset.
  useEffect(() => {
    setRosterOpen(false);
    setForwardTo(null);
    setScheduleOpen(false);
    // Same route-reuse trap as the roster: a query typed in one channel would
    // otherwise follow the reader into the next one and silently hide messages.
    setSearchOpen(false);
    setQuery("");
    setAssetsOpen(false);
    // The call is NOT reset here any more. It used to have to be, because the
    // room was rendered by this route and switching channels would have left
    // the user silently in the previous channel's call; now the meeting is held
    // above the router, so changing channel simply leaves it running — which is
    // what the floating window is for.
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

  // Reactions ride a separate query rather than the message DTO — same reason
  // as DMView: the tally is per-viewer and changes far more often than the
  // messages do, so folding it in would invalidate the channel on every tap.
  const { data: reactions = [] } = useQuery({
    queryKey: qk.channelReactions(channelId),
    queryFn: () => api.channelReactions(channelId),
    enabled: !!channelId,
  });
  const reactionsByMessage = useMemo(() => {
    const map = new Map<string, ReactionDTO[]>();
    for (const r of reactions) {
      const list = map.get(r.messageId);
      if (list) list.push(r);
      else map.set(r.messageId, [r]);
    }
    return map;
  }, [reactions]);

  // Whether the caller may moderate: remove anyone's message, and pin for
  // everyone. `myRole` is the caller's standing in THIS channel; an org_admin
  // moderates every channel without needing to be in it, which is the same rule
  // requireChannelManager applies server-side. The server re-checks regardless
  // — this only decides what to OFFER.
  const canModerate =
    channel?.myRole === "owner" ||
    channel?.myRole === "admin" ||
    !!me.roles?.includes("org_admin");

  const react = useMutation({
    mutationFn: ({ id, emoji, on }: { id: string; emoji: string; on: boolean }) =>
      api.setChannelReaction(id, emoji, on),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.channelReactions(channelId) }),
    onError: () => toast.error("Couldn't save that reaction"),
  });

  const hide = useMutation({
    mutationFn: (id: string) => api.hideChannelMessage(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.channelMessages(channelId) }),
    onError: () => toast.error("Couldn't hide that message"),
  });

  const removeForAll = useMutation({
    mutationFn: (id: string) => api.deleteChannelMessageForAll(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.channelMessages(channelId) }),
    onError: () => toast.error("Couldn't delete that message"),
  });

  const togglePin = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => api.setChannelMessagePin(id, on),
    onSuccess: (_r, { on }) => {
      qc.invalidateQueries({ queryKey: qk.channelMessages(channelId) });
      toast.success(on ? "Pinned for everyone" : "Unpinned");
    },
    onError: () => toast.error("Couldn't change the pin"),
  });

  const [scheduleOpen, setScheduleOpen] = useState(false);
  // The call currently open in this view. Held here rather than routed so
  // leaving a call returns you to the conversation you were already in.
  const { enter } = useMeetingSession();

  // Ringing the channel right now. Omitting scheduledAt is what makes the call
  // LIVE server-side; the dialog stays for a call in the diary. No title is
  // asked for — nobody is being invited, so there is nothing to label for them.
  const startCall = useMutation({
    mutationFn: (media: "audio" | "video") => api.scheduleChannelCall(channelId, { media }),
    onSuccess: (call) => {
      void qc.invalidateQueries({ queryKey: qk.calls });
      void qc.invalidateQueries({ queryKey: qk.channelCalls(channelId) });
      enter(call);
    },
    onError: () => toast.error("Couldn't start the call"),
  });
  // Guard the double-tap: the menu closes on pick, but a second click before
  // the pane switches to the call would open a second live call in the channel.
  const start = (media: "audio" | "video") => {
    if (!startCall.isPending) startCall.mutate(media);
  };

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

  /**
   * The messages as the thread renders them.
   *
   * Lifted out of the ChatThread call because three other things now read the
   * same list — the in-conversation search, the Media/Links/Docs panel and the
   * transcript export — and each of them re-deriving it from `messages` would
   * be three chances for them to disagree about what is in this conversation.
   */
  const thread = useMemo(
    () =>
      messages.map((m) => ({
        // senderUsername is the email local-part; the display name is what a
        // reader should see above a channel bubble.
        id: m.id, senderId: m.senderId, senderName: m.senderDisplayName || m.senderUsername,
        body: m.body, at: m.createdAt, kind: m.kind, isForward: m.isForward,
        pending: m.id.startsWith("temp:"),
        deletedForAll: m.deletedForAll,
        pinned: m.pinned,
        reactions: reactionsByMessage.get(m.id),
      })),
    [messages, reactionsByMessage],
  );

  // The same messages with the reader's own name normalised, for the surfaces
  // that LIST rather than render them — "You · 3h ago" above a file you shared
  // reads as it does everywhere else in the app.
  const threadForTools = useMemo(
    () => thread.map((m) => (m.senderId === me.id ? { ...m, senderName: "You" } : m)),
    [thread, me.id],
  );

  // Searching narrows what the thread draws; it does not touch what is loaded,
  // so "Load older" still widens the set being searched.
  const shown = useMemo(
    () => searchMessages(thread, searchOpen ? query : ""),
    [thread, searchOpen, query],
  );

  const prefs = useConversationPrefs();

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

  const closeSearch = () => {
    setSearchOpen(false);
    setQuery("");
  };
  /** The loaded conversation as a text file. Bounded by what is loaded, and the
   *  transcript's own header says so — see lib/chatExport. */
  const exportChat = () => {
    exportChatTranscript(threadForTools, {
      title: `#${channel.name}`,
      meId: me.id,
      now: new Date(),
    });
    toast.success(`Exported ${threadForTools.length} message${threadForTools.length === 1 ? "" : "s"}`);
  };

  return (
    <div className="flex h-full flex-col">
      {/* relative z-30, matching TopNavbar's `glass relative z-50`. backdrop-blur
          makes this header a STACKING CONTEXT that is painted at its in-flow
          position, so without a z-index of its own everything inside it — the
          options menu included — is trapped below the message list that follows
          it in the DOM, whatever z-index the menu asks for. That is what put a
          dropdown behind the photos and file cards in the thread. z-30 clears
          the list and a message's own action popover (z-20) while staying under
          the sheets and dialogs (z-50) and the lightbox (z-[100]), which should
          still cover it. */}
      <header className="relative z-30 flex items-center justify-between border-b border-border/70 bg-surface/60 px-5 py-3 backdrop-blur">
        {/* min-w-0 + truncate: a long channel name must not push the member
            count and options menu off the right edge on a narrow window. */}
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
              guest list, and the server refuses to mint a link for one. That is
              why no onSendLink is passed: the menu is three rows here, not four.
              className matches the muted icon buttons either side of it. */}
          <CallMenu
            onVoiceCall={() => start("audio")}
            onVideoCall={() => start("video")}
            onSchedule={() => setScheduleOpen(true)}
            className="h-auto gap-1.5 rounded-lg px-1.5 py-1 text-sm text-muted hover:text-fg"
          />
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
          {/* Rename, Delete and Clear Chat are deliberately left unwired:
              messaging-svc has no PATCH or DELETE for a channel, and no bulk
              hide for its messages, so the menu renders those rows disabled
              with the reason on hover rather than offering an action that
              cannot be carried out. Everything else here works today.

              "View Profile" for a channel is its membership — who is in it is
              what a channel's profile consists of — so it opens the roster the
              member count already opens. */}
          <ConversationMenu
            scope="channel"
            onViewProfile={() => setRosterOpen(true)}
            onSearch={() => setSearchOpen(true)}
            onMedia={() => setAssetsOpen(true)}
            muted={prefs.isMuted("channel", channelId)}
            onToggleMute={() => toggleConversationPref("muted", "channel", channelId)}
            shortcut={prefs.hasShortcut("channel", channelId)}
            onToggleShortcut={() => toggleConversationPref("shortcut", "channel", channelId)}
            onExport={exportChat}
            onLeave={confirmLeave}
            leaving={leave.isPending}
          />
        </div>
      </header>
      {searchOpen && (
        <ChatSearchBar
          value={query}
          onChange={setQuery}
          onClose={closeSearch}
          matches={shown.length}
          loaded={thread.length}
          placeholder={`Search #${channel.name}…`}
        />
      )}
      <ChannelMembersSheet
        open={rosterOpen}
        onClose={() => setRosterOpen(false)}
        channel={channel}
      />
      {/* Mounted only while open, as MeetingCard does with its roster sheet:
          the panel mints one signed link per attachment in the thread, and a
          closed panel doing that on a refresh interval is a request nobody
          asked for. */}
      {assetsOpen && (
        <ChatAssetsSheet
          open
          onClose={() => setAssetsOpen(false)}
          title={`#${channel.name}`}
          messages={threadForTools}
        />
      )}
      <ChatThread
        messages={shown}
        meId={me.id}
        onLoadOlder={loadOlder}
        loadingOlder={loadingOlder}
        hasOlder={hasOlder}
        // flushStaged, not send.mutate: Send must emit the attachment tray as
        // well as the text, and must tolerate an empty text (attachments only).
        // Sending drops out of search: a filtered thread would swallow the
        // message the user just sent unless it happened to match the query,
        // which reads as a send that failed.
        onSend={(t) => { media.flushStaged(t); closeSearch(); }}
        showSenderNames
        placeholder={`Message #${channel.name}…`}
        onForwardTo={(id) => {
          const msg = messages.find((m: ChannelMessageDTO) => m.id === id);
          setForwardTo({ id, body: msg?.body ?? "" });
        }}
        onForward={recordForward}
        onHide={(id) => hide.mutate(id)}
        onDeleteForAll={(id) => removeForAll.mutate(id)}
        canModerate={canModerate}
        // Pinning is a moderation capability: it changes what the whole channel
        // sees, so the entry is simply absent for an ordinary member rather than
        // present and refused.
        onTogglePin={canModerate ? (id, on) => togglePin.mutate({ id, on }) : undefined}
        onReact={(id, emoji, on) => react.mutate({ id, emoji, on })}
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
      <ForwardToDialog
        open={!!forwardTo}
        onClose={() => setForwardTo(null)}
        sourceMessageId={forwardTo?.id ?? null}
        preview={forwardTo?.body}
      />
      {scheduleOpen && (
        <ScheduleCallDialog
          scope={{ kind: "channel", channelId }}
          onClose={() => setScheduleOpen(false)}
          onStarted={(call) => {
            setScheduleOpen(false);
            enter(call);
          }}
        />
      )}
    </div>
  );
}
