import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Hash, Users, ChevronLeft, Lock } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@taskboard/ui";
import type {
  ChannelDTO,
  ChannelMessageDTO,
  ChannelReadReceiptDTO,
  ReactionDTO,
} from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { useMessageFocus } from "../lib/useMessageFocus";
import { qk } from "../lib/queryBridge";
import { ChatThread } from "../features/ChatThread";
import { useOlderMessages } from "../lib/useOlderMessages";
import { ChannelMembersSheet } from "../features/ChannelMembersSheet";
import { LeaveChannelDialog } from "../features/LeaveChannelDialog";
import { useWhatsAppForward } from "../lib/useWhatsAppForward";
import { ForwardToDialog } from "../features/ForwardToDialog";
import { RenameChannelDialog } from "../features/RenameChannelDialog";
import { useChatMedia } from "../features/useChatMedia";
import { useOptimisticSend } from "../lib/useOptimisticSend";
import { useMarkReadWhileViewing } from "../lib/useMarkReadWhileViewing";
import { ScheduleCallDialog } from "../features/ScheduleCallDialog";
import { CallMenu } from "../features/CallMenu";
import { ConversationMenu } from "../features/ConversationMenu";
import { ConfirmDialog } from "../features/ConfirmDialog";
import { SelectionToolbar } from "../features/SelectionToolbar";
import { useMessageSelection } from "../lib/useMessageSelection";
import { canDeleteForAll, canModerateChannel } from "../lib/messagePermissions";
import { ChatSearchBar } from "../features/ChatSearchBar";
import { ChatAssetsSheet } from "../features/ChatAssetsSheet";
import { searchMessages } from "../lib/chatSearch";
import { exportChatTranscript } from "../lib/chatExport";
import { toggleConversationPref, useConversationPrefs } from "../lib/conversationPrefs";
import { useMeetingSession } from "../lib/MeetingSession";
import { useActiveThread, type ActiveThread } from "../lib/activeThread";
import { useMarkTargetNotificationsRead } from "../lib/useMarkTargetNotificationsRead";
import { isAttachmentActivityKind, showsAttachmentActivity } from "../lib/useAttachmentActivity";

export function ChannelView() {
  const { t } = useTranslation("chatThread");
  const { channelId = "" } = useParams();
  const focusMessage = useMessageFocus();
  // The task a "Chat" button opened this channel for (?taskId=…, same pattern
  // as useMessageFocus's ?m=). Drives the composer's send-routing below (so a
  // message sent while this is set is permanently tagged via the task
  // discussion endpoint); dropped by every ordinary channel-switch navigation
  // (plain pathname, no carried-over search string — see ChannelsList.tsx),
  // so it never lingers onto an unrelated channel.
  const [searchParams] = useSearchParams();
  const focusTaskId = searchParams.get("taskId");
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [rosterOpen, setRosterOpen] = useState(false);
  // The header's overflow menu opens these three: an inline search over the
  // loaded messages, the shared-files panel, and nothing else that needs state.
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [clearChatOpen, setClearChatOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const recordForward = useWhatsAppForward();
  // The message(s) being forwarded to another chat or channel (null = closed).
  // A single-message forward is a one-element `ids` array — same dialog, same
  // mutation, same code path as a bulk-selection forward.
  const [forwardTo, setForwardTo] = useState<{ ids: string[]; preview: string } | null>(null);
  const me = useSession((s) => s.user)!;
  const nav = useNavigate();
  const selection = useMessageSelection(channelId);

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
    setRenameOpen(false);
    setClearChatOpen(false);
    setLeaveOpen(false);
    setDeleteOpen(false);
    setBulkDeleteOpen(false);
    // Selection state itself resets inside useMessageSelection, which owns
    // this same channelId — see that hook's own doc comment.
    // The call is NOT reset here any more. It used to have to be, because the
    // room was rendered by this route and switching channels would have left
    // the user silently in the previous channel's call; now the meeting is held
    // above the router, so changing channel simply leaves it running — which is
    // what the floating window is for.
  }, [channelId]);

  const { data: channels = [] } = useQuery({ queryKey: qk.channels, queryFn: () => api.channels() });
  const channel = channels.find((c: ChannelDTO) => c.id === channelId);
  const showAttachmentActivity = showsAttachmentActivity("channel", channel?.isLocked);

  // Tell ScreenshotNotice this channel is the one on screen — same purpose as
  // DMView's registration; see lib/activeThread for why it can't read the URL
  // itself despite channelId living right there in the route.
  const setActiveThread = useActiveThread((s) => s.setActiveThread);
  const clearActiveThread = useActiveThread((s) => s.clearActiveThread);
  useEffect(() => {
    if (!channelId) return;
    const t: ActiveThread = { kind: "channel", channelId };
    setActiveThread(t);
    return () => clearActiveThread(t);
  }, [channelId, setActiveThread, clearActiveThread]);

  // Opening a channel reads its notifications — scoped to this channel on the server.
  useMarkTargetNotificationsRead(api, "channelId", channelId);

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

  /**
   * Tell the server how far this reader has got.
   *
   * This is what puts anything in the receipts at all — a channel's "seen"
   * state is a cursor per member, and nothing else moves it. Same shape as
   * DMView's api.read call, and keyed on the newest message's seq (not the
   * count) while the tab is visible and focused — see useMarkReadWhileViewing:
   * a re-render, or an older page prepended, changes nothing about how far the
   * reader has got and should not re-post the same position.
   *
   * Failures are swallowed deliberately. A read receipt that does not land is
   * worth nothing to the reader and an error toast about it would interrupt
   * them over somebody else's badge.
   *
   * The qk.channels invalidation on success is required now that the sidebar's
   * unread badge is server-computed (ChannelDTO.unread) rather than a
   * client-local dot: without it, qk.channels — where that count lives — is
   * never told the read happened, and the badge keeps showing the pre-read
   * count until something unrelated refetches it. Same fix, same reason, as
   * DMView's equivalent effect for qk.conversations.
   */
  useMarkReadWhileViewing(channelId, messages, (maxSeq) => {
    api
      .markChannelRead(channelId, maxSeq)
      .then(() => qc.invalidateQueries({ queryKey: qk.channels }))
      .catch(() => {});
  });

  /**
   * Who has read MY messages. Only mine, because "Seen by" renders on the
   * caller's own bubbles alone — asking about everybody's would be a request
   * several times the size for receipts nothing draws.
   *
   * Optimistic sends are excluded: a `temp:` id is not a message the server has
   * heard of, and asking about it would spend a slot of the endpoint's id cap
   * on a row that cannot exist.
   */
  const myMessageIds = useMemo(
    () =>
      messages
        .filter((m: ChannelMessageDTO) => m.senderId === me.id && !m.id.startsWith("temp:"))
        .map((m: ChannelMessageDTO) => m.id),
    [messages, me.id],
  );
  const { data: receipts = [] } = useQuery({
    queryKey: qk.channelReadReceipts(channelId),
    queryFn: () => api.channelReadReceipts(channelId, myMessageIds),
    enabled: !!channelId && myMessageIds.length > 0,
    // Somebody else catching up is not something this client is told about —
    // there is no read event on the channel wire — so the only way the badge
    // ever moves while the sender watches is to ask again. Slow on purpose:
    // "who has seen it" is not a number anyone needs to the second.
    refetchInterval: 30_000,
  });

  // A message of my own that the server now knows about is a message with a
  // receipt to ask for. Keyed on the ids themselves rather than the count, so
  // an optimistic send being replaced by its real id also re-asks.
  const myIdsKey = myMessageIds.join(",");
  useEffect(() => {
    if (myIdsKey) void qc.invalidateQueries({ queryKey: qk.channelReadReceipts(channelId) });
  }, [myIdsKey, channelId, qc]);

  const receiptsByMessage = useMemo(() => {
    const map = new Map<string, ChannelReadReceiptDTO[]>();
    for (const r of receipts) {
      const list = map.get(r.messageId);
      if (list) list.push(r);
      else map.set(r.messageId, [r]);
    }
    return map;
  }, [receipts]);

  const canModerate = canModerateChannel(channel, me);

  // mutationKey scopes each of this view's mutations to the current
  // channelId. ChannelView never unmounts on a channel switch (same route
  // component, new channelId prop), so without a differing mutationKey a
  // still-pending mutation's onSuccess/onError gets silently rebound to the
  // NEW channel's closures when the observer re-renders mid-request — e.g. a
  // slow "hide" in channel A that resolves after switching to B would
  // invalidate B's messages instead of A's. A differing mutationKey makes
  // react-query detach the observer instead of rebinding (see
  // useOptimisticSend.ts for the verified mechanism and full writeup).
  const react = useMutation({
    mutationKey: ["channelReact", channelId],
    mutationFn: ({ id, emoji, on }: { id: string; emoji: string; on: boolean }) =>
      api.setChannelReaction(id, emoji, on),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.channelReactions(channelId) }),
    onError: () => toast.error(t("channelView.errors.reactionSave")),
  });
  // Guards against a fast double-tap firing two overlapping requests for the
  // SAME (message, emoji) chip — see DMView.tsx's identical reactToggle for
  // why setChannelReaction's lack of an idempotency key makes this matter,
  // and why the guard is a ref rather than state.
  const pendingReactionsRef = useRef<Set<string>>(new Set());
  const reactToggle = useCallback(
    (id: string, emoji: string, on: boolean) => {
      const key = `${id} ${emoji}`;
      if (pendingReactionsRef.current.has(key)) return;
      pendingReactionsRef.current.add(key);
      react.mutate(
        { id, emoji, on },
        { onSettled: () => pendingReactionsRef.current.delete(key) },
      );
    },
    [react],
  );

  const hide = useMutation({
    mutationKey: ["channelHide", channelId],
    mutationFn: (id: string) => api.hideChannelMessage(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.channelMessages(channelId) }),
    onError: () => toast.error(t("channelView.errors.hideMessage")),
  });

  const markUnread = useMutation({
    mutationKey: ["channelMarkUnread", channelId],
    mutationFn: (upToSeq: number) => api.markChannelRead(channelId, upToSeq),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.channels }),
    onError: () => toast.error(t("channelView.errors.markUnread")),
  });

  const clearChat = useMutation({
    mutationKey: ["channelClear", channelId],
    mutationFn: () => api.clearChannel(channelId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.channelMessages(channelId) });
      // The sidebar's last-message preview comes from this list query — without
      // this it keeps showing the pre-clear text until something unrelated
      // happens to refetch it.
      void qc.invalidateQueries({ queryKey: qk.channels });
      toast.success(t("channelView.clearMessagesToast"));
    },
    onError: () => toast.error(t("channelView.errors.clearMessages")),
  });

  const removeForAll = useMutation({
    mutationKey: ["channelRemoveForAll", channelId],
    mutationFn: (id: string) => api.deleteChannelMessageForAll(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.channelMessages(channelId) }),
    onError: () => toast.error(t("channelView.errors.deleteMessage")),
  });

  // The selected rows, and how many of them this caller may delete for
  // everyone (author, or any moderator) — drives the confirm dialog's
  // wording only. The mutation always sends every selected id; the server
  // decides which it will actually delete.
  const selectedMessages = useMemo(
    () => messages.filter((m: ChannelMessageDTO) => selection.selected.has(m.id)),
    [messages, selection.selected],
  );
  const deletableCount = useMemo(
    () => selectedMessages.filter((m) => canDeleteForAll(m, me.id, canModerate)).length,
    [selectedMessages, me.id, canModerate],
  );

  const bulkDelete = useMutation({
    mutationKey: ["channelBulkDelete", channelId],
    mutationFn: (ids: string[]) => api.deleteChannelMessagesForAll(channelId, ids),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: qk.channelMessages(channelId) });
      void qc.invalidateQueries({ queryKey: qk.channels });
      setBulkDeleteOpen(false);
      selection.exit();
      const total = res.deleted.length + res.skipped.length;
      if (res.skipped.length === 0) {
        toast.success(t("channelView.bulkDelete.deletedToast", { count: res.deleted.length }));
      } else {
        toast.warning(t("channelView.bulkDelete.partialToast", { deleted: res.deleted.length, total }), {
          description: t("channelView.bulkDelete.partialDescription", { count: res.skipped.length }),
        });
      }
    },
    // Selection is deliberately KEPT on failure, so a retry is one click.
    onError: () => toast.error(t("channelView.errors.deleteMessages")),
  });

  const togglePin = useMutation({
    mutationKey: ["channelTogglePin", channelId],
    mutationFn: ({ id, on }: { id: string; on: boolean }) => api.setChannelMessagePin(id, on),
    onSuccess: (_r, { on }) => {
      qc.invalidateQueries({ queryKey: qk.channelMessages(channelId) });
      toast.success(on ? t("channelView.pinToggle.pinned") : t("channelView.pinToggle.unpinned"));
    },
    onError: () => toast.error(t("channelView.errors.changePin")),
  });

  const [scheduleOpen, setScheduleOpen] = useState(false);
  // The call currently open in this view. Held here rather than routed so
  // leaving a call returns you to the conversation you were already in.
  const { enter } = useMeetingSession();

  // Ringing the channel right now. Omitting scheduledAt is what makes the call
  // LIVE server-side; the dialog stays for a call in the diary. No title is
  // asked for — nobody is being invited, so there is nothing to label for them.
  const startCall = useMutation({
    mutationKey: ["channelStartCall", channelId],
    mutationFn: (media: "audio" | "video") => api.scheduleChannelCall(channelId, { media }),
    onSuccess: (call) => {
      void qc.invalidateQueries({ queryKey: qk.calls });
      void qc.invalidateQueries({ queryKey: qk.channelCalls(channelId) });
      enter(call);
    },
    onError: () => toast.error(t("channelView.errors.startCall")),
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
    mutationKey: ["channelLeave", channelId],
    mutationFn: () => api.leaveChannel(channelId),
    onSuccess: () => {
      toast.success(t("channelView.leftChannelToast", { name: channel?.name }));
      void qc.invalidateQueries({ queryKey: qk.channels });
      void qc.invalidateQueries({ queryKey: qk.openChannels });
      nav("/app/channels");
    },
    onError: (e) => toast.error(t("channelView.errors.leave"), { description: String(e) }),
  });

  const confirmLeave = () => {
    if (!channel) return;
    setLeaveOpen(true);
  };

  const confirmRename = () => setRenameOpen(true);

  const deleteChannel = useMutation({
    mutationKey: ["channelDelete", channelId],
    mutationFn: () => api.deleteChannel(channelId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.channels });
      nav("/app/channels");
      toast.success(t("channelView.deletedChannelToast"));
    },
    onError: () => toast.error(t("channelView.errors.deleteChannel")),
  });

  const confirmDelete = () => setDeleteOpen(true);

  // The message being quoted, if any. Cleared on send and on channel switch.
  //
  // Mirrored into a ref because useChatMedia closes over `send` and would
  // otherwise capture a stale value: the quote must be read at the moment the
  // user presses Send, not at the moment the hook was built. Same pattern as
  // DMView's replyTo/replyToRef.
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const replyToRef = useRef<string | null>(null);
  replyToRef.current = replyTo;
  useEffect(() => setReplyTo(null), [channelId]);

  /** Consume the pending quote: it applies to the FIRST message this send
   *  emits, and to nothing after it. */
  const takeReply = () => {
    const id = replyToRef.current ?? undefined;
    replyToRef.current = null;
    if (id) setReplyTo(null);
    return id;
  };

  const send = useOptimisticSend<ChannelMessageDTO>({
    queryKey: qk.channelMessages(channelId),
    buildOptimistic: (tempId, { body, replyToId }, prev) => ({
      id: tempId,
      channelId,
      seq: prev.reduce((m, x) => Math.max(m, x.seq), 0) + 1,
      senderId: me.id,
      senderUsername: me.username,
      senderDisplayName: me.displayName,
      body,
      replyToId,
      taskId: focusTaskId ?? undefined,
      createdAt: new Date().toISOString(),
    }),
    // Task-focused (?taskId=, or opened via a task's "Chat" button): route
    // through the task-discussion endpoint instead of the plain send, so the
    // message is permanently tagged (ChatThread's "Task: {title}" label)
    // rather than relying on the now-removed ephemeral banner. `channelId` is
    // this view's own route param, already membership-checked server-side —
    // never a client-supplied target — so this can only tag the user's own
    // sends in the channel they are actually in.
    mutationFn: ({ body, replyToId }) =>
      focusTaskId
        ? api.sendTaskDiscussionMessage(focusTaskId, body, undefined, { channelId }, replyToId)
        : api.sendChannelMessage(channelId, body, undefined, undefined, replyToId),
    // No reconcile: unlike DMView's messages, a ChannelMessageDTO carries no
    // `status` field at all (channels use per-member read receipts instead —
    // see receiptsByMessage below), so the plain id/seq patch is everything
    // a channel send needs.
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.channels }),
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
      messages
        // File open/download notices belong to LOCKED channels only; older ones
        // already stored in an open channel are not drawn either.
        .filter((m) => showAttachmentActivity || !isAttachmentActivityKind(m.kind))
        .map((m) => ({
        // senderUsername is the email local-part; the display name is what a
        // reader should see above a channel bubble.
        id: m.id, senderId: m.senderId, senderName: m.senderDisplayName || m.senderUsername,
        body: m.body, at: m.createdAt, kind: m.kind, isForward: m.isForward,
        forwardPlatform: m.forwardPlatform, taskId: m.taskId ?? undefined,
        pending: m.id.startsWith("temp:"),
        replyToId: m.replyToId,
        deletedForAll: m.deletedForAll,
        pinned: m.pinned,
        reactions: reactionsByMessage.get(m.id),
        channelReceipts: receiptsByMessage.get(m.id),
      })),
    [messages, showAttachmentActivity, reactionsByMessage, receiptsByMessage],
  );

  // The same messages with the reader's own name normalised, for the surfaces
  // that LIST rather than render them — "You · 3h ago" above a file you shared
  // reads as it does everywhere else in the app.
  const threadForTools = useMemo(
    () => thread.map((m) => (m.senderId === me.id ? { ...m, senderName: t("shared.you") } : m)),
    [thread, me.id, t],
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
    channelLocked: channel?.isLocked,
    contextName: channel?.name,
    send: (body) => send.mutate({ body, replyToId: takeReply() }),
  });

  if (!channel)
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={<Hash size={24} />}
          title={t("channelView.notFound.title")}
          hint={t("channelView.notFound.hint")}
        />
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
    toast.success(t("channelView.exportedToast", { count: threadForTools.length }));
  };

  return (
    <div className="flex h-full flex-col">
      {/* relative z-50, actually matching TopNavbar's `glass relative z-50`
          (it claimed to match at z-30 before, which is still below TopNavbar).
          backdrop-blur makes this header a STACKING CONTEXT that is painted at
          its in-flow position, so without a z-index of its own everything
          inside it — the options menu included — is trapped below whatever it
          is compared against, no matter what z-index the menu itself asks for.
          z-30 cleared the message list and a message's own action popover
          (z-20), but was still capped below TopNavbar (z-50), which is what put
          the options/call menu behind the top nav bar. z-50 clears TopNavbar
          too while staying under the lightbox (z-[100]), which should still
          cover it. A plain Modal overlay is ALSO `fixed inset-0 z-50`, so one
          mounted earlier in the DOM (a sidebar pane's dialog) loses the tie to
          this header and is painted under it; a dialog that can open next to a
          channel passes `elevated` (see Modal) rather than this header
          giving way. */}
      <header className="relative z-50 flex items-center justify-between border-b border-border/70 bg-surface/60 px-5 py-3 backdrop-blur">
        {/* min-w-0 + truncate: a long channel name must not push the member
            count and options menu off the right edge on a narrow window. */}
        <div className="flex min-w-0 items-center gap-2">
          <button
            onClick={() => nav("/app/channels")}
            title={t("channelView.header.backToChannels")}
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
              {t("channelView.header.locked")}
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
            title={t("channelView.header.membersTitle")}
            aria-label={t("channelView.header.membersAriaLabel", { count: channel.memberCount })}
            className="flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <Users size={15} /> {channel.memberCount}
          </button>
          {/* "View Profile" for a channel is its membership — who is in it is
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
            onSelectMessages={() => { closeSearch(); selection.enter(); }}
            onClearChat={() => setClearChatOpen(true)}
            onLeave={confirmLeave}
            leaving={leave.isPending}
            onRename={confirmRename}
            onDelete={confirmDelete}
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
          placeholder={t("channelView.search.placeholder", { name: channel.name })}
        />
      )}
      <ChannelMembersSheet
        open={rosterOpen}
        onClose={() => setRosterOpen(false)}
        channel={channel}
      />
      <RenameChannelDialog
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        channelId={channelId}
        currentName={channel.name}
      />
      <ConfirmDialog
        open={clearChatOpen}
        onClose={() => setClearChatOpen(false)}
        title={t("channelView.clearMessagesDialog.title")}
        message={t("channelView.clearMessagesDialog.message")}
        confirmLabel={t("channelView.clearMessagesDialog.confirmLabel")}
        danger
        busy={clearChat.isPending}
        onConfirm={() => clearChat.mutate(undefined, { onSuccess: () => setClearChatOpen(false) })}
      />
      <LeaveChannelDialog
        channel={channel}
        open={leaveOpen}
        onClose={() => setLeaveOpen(false)}
        busy={leave.isPending}
        onConfirm={() => leave.mutate(undefined, { onSuccess: () => setLeaveOpen(false) })}
      />
      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={
          channel
            ? t("channelView.deleteChannelDialog.titleNamed", { name: channel.name })
            : t("channelView.deleteChannelDialog.titleFallback")
        }
        message={t("channelView.deleteChannelDialog.message")}
        confirmLabel={t("channelView.deleteChannelDialog.confirmLabel")}
        danger
        busy={deleteChannel.isPending}
        onConfirm={() => deleteChannel.mutate(undefined, { onSuccess: () => setDeleteOpen(false) })}
      />
      <ConfirmDialog
        open={bulkDeleteOpen}
        onClose={() => setBulkDeleteOpen(false)}
        title={t("channelView.bulkDeleteDialog.title", { count: deletableCount })}
        message={
          deletableCount === selection.count
            ? t("channelView.bulkDeleteDialog.messageAll")
            : t("channelView.bulkDeleteDialog.messagePartial", {
                remaining: selection.count - deletableCount,
                total: selection.count,
                deletable: deletableCount,
              })
        }
        confirmLabel={t("channelView.bulkDeleteDialog.confirmLabel")}
        danger
        busy={bulkDelete.isPending}
        onConfirm={() => bulkDelete.mutate(selectedMessages.map((m) => m.id))}
      />
      {/* Mounted only while open: the panel mints one signed link per
          attachment in the thread, and a closed panel doing that on a
          refresh interval is a request nobody asked for. */}
      {assetsOpen && (
        <ChatAssetsSheet
          open
          onClose={() => setAssetsOpen(false)}
          title={`#${channel.name}`}
          messages={threadForTools}
          scope="channel"
          scopeId={channelId}
          meId={me.id}
          channelLocked={channel.isLocked}
          contextName={channel.name}
        />
      )}
      <ChatThread
        threadId={channelId}
        messages={shown}
        meId={me.id}
        onLoadOlder={loadOlder}
        loadingOlder={loadingOlder}
        hasOlder={hasOlder}
        focusMessageId={focusMessage.messageId}
        onFocusHandled={focusMessage.clear}
        // flushStaged, not send.mutate: Send must emit the attachment tray as
        // well as the text, and must tolerate an empty text (attachments only).
        // Sending drops out of search: a filtered thread would swallow the
        // message the user just sent unless it happened to match the query,
        // which reads as a send that failed.
        onSend={(t) => { media.flushStaged(t); closeSearch(); }}
        // Resolved from `thread`, not the raw `messages` DTOs: thread already
        // carries the computed senderName (displayName || username), which the
        // composer's "Replying to X" bar needs and a raw ChannelMessageDTO does
        // not have.
        replyTo={replyTo ? thread.find((m) => m.id === replyTo) ?? null : null}
        onCancelReply={() => setReplyTo(null)}
        onReply={(id) => setReplyTo(id)}
        showSenderNames
        placeholder={t("channelView.composer.placeholder", { name: channel.name })}
        onForwardTo={(id) => {
          const msg = messages.find((m: ChannelMessageDTO) => m.id === id);
          setForwardTo({ ids: [id], preview: msg?.body ?? "" });
        }}
        onForward={recordForward}
        onHide={(id) => hide.mutate(id)}
        onMarkUnread={(id) => {
          const message = messages.find((m: ChannelMessageDTO) => m.id === id);
          if (message) markUnread.mutate(Math.max(0, message.seq - 1));
        }}
        onDeleteForAll={(id) => removeForAll.mutate(id)}
        canModerate={canModerate}
        // Pinning is a moderation capability: it changes what the whole channel
        // sees, so the entry is simply absent for an ordinary member rather than
        // present and refused.
        onTogglePin={canModerate ? (id, on) => togglePin.mutate({ id, on }) : undefined}
        onReact={reactToggle}
        selectionMode={selection.active}
        selectedIds={selection.selected}
        onToggleSelect={selection.toggle}
        selectionToolbar={
          selection.active ? (
            <SelectionToolbar
              count={selection.count}
              deletableCount={deletableCount}
              busy={bulkDelete.isPending}
              onCancel={selection.exit}
              onDelete={() => {
                if (deletableCount === 0) {
                  toast.error(t("channelView.errors.noneDeletable"));
                  return;
                }
                setBulkDeleteOpen(true);
              }}
              onForward={() => {
                setForwardTo({
                  // `messages` is already seq-ordered, so filtering it
                  // preserves that order — this is only for the dialog's own
                  // preview strip; the server sorts authoritatively.
                  ids: selectedMessages.map((m) => m.id),
                  preview: selectedMessages[0]?.body ?? "",
                });
              }}
            />
          ) : undefined
        }
        renderBody={media.renderBody}
        onDownloadFile={media.downloadItem}
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
        sourceMessageIds={forwardTo?.ids ?? []}
        preview={forwardTo?.preview}
        onDone={selection.exit}
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
