import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X, MessageSquare, ChevronLeft, Ban } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Avatar, Button, EmptyState } from "@taskboard/ui";
import type { ConversationDTO, MessageDTO, ReactionDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { useSession } from "../store/session";
import { qk } from "../lib/queryBridge";
import { displayNameOf, useUserLabels } from "../lib/userLabel";
import { CallMenu } from "../features/CallMenu";
import { ScheduleCallDialog } from "../features/ScheduleCallDialog";
import { SendCallLinkDialog } from "../features/SendCallLinkDialog";
import { deliverCallLink } from "../lib/deliverCallLink";
import { ChatThread } from "../features/ChatThread";
import { ConversationMenu } from "../features/ConversationMenu";
import { ConfirmDialog } from "../features/ConfirmDialog";
import { SelectionToolbar } from "../features/SelectionToolbar";
import { useMessageSelection } from "../lib/useMessageSelection";
import { canDeleteForAll } from "../lib/messagePermissions";
import { ChatSearchBar } from "../features/ChatSearchBar";
import { ChatAssetsSheet } from "../features/ChatAssetsSheet";
import { searchMessages } from "../lib/chatSearch";
import { exportChatTranscript } from "../lib/chatExport";
import { toggleConversationPref, useConversationPrefs } from "../lib/conversationPrefs";
import { useWhatsAppForward } from "../lib/useWhatsAppForward";
import { ForwardToDialog } from "../features/ForwardToDialog";
import { useChatMedia } from "../features/useChatMedia";
import { useOptimisticSend } from "../lib/useOptimisticSend";
import { useChatTyping } from "../lib/useChatTyping";
import { useCall } from "../lib/useCall";
import { useOlderMessages } from "../lib/useOlderMessages";
import { useUserStatus } from "../lib/usePresence";
import { useSelectedChat } from "../lib/selectedChat";
import { useActiveThread, type ActiveThread } from "../lib/activeThread";

export function DMView() {
  // From memory, not from the path: the conversation id is deliberately absent
  // from the URL (see lib/selectedChat). Everything below is unchanged — this
  // is still one conversation's worth of state, it is just told which one by
  // the shell rather than by the router.
  const { t } = useTranslation("chatThread");
  const { selectedId, closeChat } = useSelectedChat();
  const conversationId = selectedId ?? "";
  const { api, config } = useRuntime();
  const qc = useQueryClient();
  const me = useSession((s) => s.user)!;
  const nav = useNavigate();

  const { data: conversations = [] } = useQuery({ queryKey: qk.conversations, queryFn: () => api.conversations() });
  const conv = conversations.find((c: ConversationDTO) => c.id === conversationId);

  // One person. This screen used to poll the entire organisation's online set
  // every 20 seconds to light a single dot — see lib/usePresence.
  const statusOf = useUserStatus(conv ? [conv.peerId] : []);
  const peerStatus = conv ? statusOf(conv.peerId) : "offline";
  // Resolved live rather than trusted from the conversation row — see
  // displayNameOf's docstring on why the embedded copy can lag a change.
  const { avatarUrlOf } = useUserLabels(conv ? [conv.peerId] : []);
  // Reachable, not "shows a green dot". Someone on a call is connected and can
  // be rung — Busy tells the caller what they are interrupting, it does not
  // put the peer behind glass.
  const isOnline = peerStatus !== "offline";

  // Newest page only. Older pages are prepended into this same flat array by
  // useOlderMessages, so every optimistic update and websocket patch below
  // keeps working against one cache shape.
  const { data: messages = [] } = useQuery({
    queryKey: qk.messages(conversationId),
    queryFn: () => api.messages(conversationId),
    enabled: !!conversationId,
  });

  const { loadOlder, loadingOlder, hasOlder } = useOlderMessages(
    qk.messages(conversationId),
    conversationId,
    messages,
    (beforeSeq, limit) => api.messages(conversationId, beforeSeq, limit),
    // Reactions are windowed by the same cursor, so an older page needs its own
    // tallies fetched and merged — otherwise those bubbles render chip-less.
    (beforeSeq, limit) => {
      api
        .conversationReactions(conversationId, beforeSeq, limit)
        .then((older) => {
          if (older.length === 0) return;
          qc.setQueryData<ReactionDTO[]>(qk.reactions(conversationId), (prev) => {
            const held = new Set((prev ?? []).map((r) => `${r.messageId}|${r.emoji}`));
            return [...(prev ?? []), ...older.filter((r) => !held.has(`${r.messageId}|${r.emoji}`))];
          });
        })
        .catch(() => {
          /* Chips are decoration; a failed tally must not break paging. */
        });
    },
  );

  const { peerTyping, onType, stop: stopTyping } = useChatTyping(conversationId, conv?.peerId);
  const call = useCall();

  // Arms a forward; the WhatsApp handoff is the menu anchor's own doing and the
  // record is written only once the user comes back. Available to every org
  // member — the link needs no connected account.
  const recordForward = useWhatsAppForward();
  // The message(s) being forwarded to another chat or channel (null = closed).
  // A single-message forward is a one-element `ids` array — same dialog, same
  // mutation, same code path as a bulk-selection forward.
  const [forwardTo, setForwardTo] = useState<{ ids: string[]; preview: string } | null>(null);
  // "Schedule Call" from the header's call menu.
  const [scheduleOpen, setScheduleOpen] = useState(false);
  /** The "who else gets the link" dialog. */
  const [linkOpen, setLinkOpen] = useState(false);
  // The header's overflow menu opens these two: an inline search over the
  // loaded messages, and the shared-files panel.
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [clearChatOpen, setClearChatOpen] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const selection = useMessageSelection(conversationId);

  // Same route-reuse trap as ChannelView's members sheet: navigating to another
  // conversation keeps this component mounted, so the scheduler — which is
  // scoped to a peer — would follow the user into the next chat.
  useEffect(() => {
    setForwardTo(null);
    setScheduleOpen(false);
    // A query typed in one chat would otherwise follow the reader into the next
    // one and silently hide messages there.
    setSearchOpen(false);
    setQuery("");
    setAssetsOpen(false);
    setClearChatOpen(false);
    setBulkDeleteOpen(false);
    // Selection state itself resets inside useMessageSelection, which owns
    // this same conversationId — see that hook's own doc comment.
  }, [conversationId]);

  useEffect(() => {
    const maxSeq = messages.reduce((m, x) => Math.max(m, x.seq), 0);
    if (maxSeq === 0) return;
    // The server's MessageRead event (which would otherwise refetch this)
    // is routed only to the peer, so their sent-message bubbles flip to
    // Seen — it never reaches the reader's own sessions. Without this,
    // qk.conversations — where the unread badge's count is computed — is
    // never told the read happened, and the badge keeps showing the
    // pre-read count until something unrelated refetches it.
    api
      .read(conversationId, maxSeq)
      .then(() => qc.invalidateQueries({ queryKey: qk.conversations }))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, conversationId]);

  // The message being quoted, if any. Cleared on send and on navigation.
  //
  // Mirrored into a ref because useChatMedia closes over `send` and would
  // otherwise capture a stale value: the quote must be read at the moment the
  // user presses Send, not at the moment the hook was built.
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const replyToRef = useRef<string | null>(null);
  replyToRef.current = replyTo;
  useEffect(() => setReplyTo(null), [conversationId]);

  /** Consume the pending quote: it applies to the FIRST message this send
   *  emits, and to nothing after it. */
  const takeReply = () => {
    const id = replyToRef.current ?? undefined;
    replyToRef.current = null;
    if (id) setReplyTo(null);
    return id;
  };

  // Reactions ride a separate query rather than the message DTO: the tally is
  // per-viewer and changes far more often than the messages do, so folding it
  // into the message list would invalidate the whole thread on every tap.
  const { data: reactions = [] } = useQuery({
    queryKey: qk.reactions(conversationId),
    queryFn: () => api.conversationReactions(conversationId),
    enabled: !!conversationId,
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

  // mutationKey scopes each of this view's mutations to the current
  // conversationId. DMView never unmounts on a conversation switch (same
  // route component, new conversationId prop), so without a differing
  // mutationKey a still-pending mutation's onSuccess/onError gets silently
  // rebound to the NEW conversation's closures when the observer re-renders
  // mid-request (see useOptimisticSend.ts for the verified mechanism).
  const react = useMutation({
    mutationKey: ["dmReact", conversationId],
    mutationFn: ({ id, emoji, on }: { id: string; emoji: string; on: boolean }) =>
      api.setReaction(id, emoji, on),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.reactions(conversationId) }),
    onError: () => toast.error(t("dmView.errors.reactionSave")),
  });
  // Guards against a fast double-tap firing two overlapping requests for the
  // SAME (message, emoji) chip: setReaction carries no idempotency key, and a
  // PUT racing a DELETE for one toggle has no ordering guarantee — whichever
  // request's transaction commits last wins, which is not necessarily the
  // user's actual last tap. A ref (not state) so the check is synchronous and
  // immune to React batching two rapid clicks into the same render.
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
    mutationKey: ["dmHide", conversationId],
    mutationFn: (id: string) => api.hideMessage(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.messages(conversationId) }),
    onError: () => toast.error(t("dmView.errors.hideMessage")),
  });

  const markUnread = useMutation({
    mutationKey: ["dmMarkUnread", conversationId],
    mutationFn: (upToSeq: number) => api.read(conversationId, upToSeq),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.conversations }),
    onError: () => toast.error(t("dmView.errors.markUnread")),
  });

  const removeForAll = useMutation({
    mutationKey: ["dmRemoveForAll", conversationId],
    mutationFn: (id: string) => api.deleteMessageForAll(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.messages(conversationId) }),
    onError: () => toast.error(t("dmView.errors.deleteMessage")),
  });

  // The selected rows, and how many of them this caller may delete for
  // everyone (author-only in a DM) — drives the confirm dialog's wording
  // only. The mutation itself always sends every selected id; the server
  // decides which it will actually delete.
  const selectedMessages = useMemo(
    () => messages.filter((m) => selection.selected.has(m.id)),
    [messages, selection.selected],
  );
  const deletableCount = useMemo(
    () => selectedMessages.filter((m) => canDeleteForAll(m, me.id)).length,
    [selectedMessages, me.id],
  );

  const bulkDelete = useMutation({
    mutationKey: ["dmBulkDelete", conversationId],
    mutationFn: (ids: string[]) => api.deleteMessagesForAll(conversationId, ids),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: qk.messages(conversationId) });
      void qc.invalidateQueries({ queryKey: qk.conversations });
      setBulkDeleteOpen(false);
      selection.exit();
      const total = res.deleted.length + res.skipped.length;
      if (res.skipped.length === 0) {
        toast.success(t("dmView.bulkDelete.deletedToast", { count: res.deleted.length }));
      } else {
        toast.warning(t("dmView.bulkDelete.partialToast", { deleted: res.deleted.length, total }), {
          description: t("dmView.bulkDelete.partialDescription", { count: res.skipped.length }),
        });
      }
    },
    // Selection is deliberately KEPT on failure, so a retry is one click.
    onError: () => toast.error(t("dmView.errors.deleteMessages")),
  });

  const reply = useOptimisticSend<MessageDTO>({
    queryKey: qk.messages(conversationId),
    buildOptimistic: (tempId, { body, replyToId }, prev) => ({
      id: tempId,
      conversationId,
      seq: prev.reduce((m, x) => Math.max(m, x.seq), 0) + 1,
      senderId: me.id,
      body,
      replyToId,
      createdAt: new Date().toISOString(),
    }),
    mutationFn: ({ body, replyToId }) => api.reply(conversationId, body, undefined, replyToId),
    // SENT is the whole point of the 201, and it has to be written here: the
    // optimistic row carries no status (it has not reached the server yet) and
    // `pending` stops being true the moment the real id lands. Without it the
    // bubble goes from "Sending…" to a blank — the server says SENT, but
    // nothing refetches this list, so the badge stayed empty until the receipt
    // for the NEXT state happened to arrive.
    reconcile: (m) => ({ ...m, status: "SENT" as const }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.conversations }),
  });

  const ignore = useMutation({
    mutationKey: ["dmIgnore", conversationId],
    mutationFn: () => api.ignoreConversation(conversationId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.conversations });
      // Closing the selection IS returning to the list now that the section has
      // one URL — navigating to /app/chats from /app/chats would leave the
      // ignored conversation open on screen.
      closeChat();
    },
    onError: () => toast.error(t("dmView.errors.removeConversation")),
  });

  // Clears the caller's own history only — unlike "Ignore" above, the
  // conversation stays in the list (with a blank preview) rather than
  // disappearing from both inboxes. Mirrors ChannelView's clearChat.
  const clearChat = () => {
    api.clearConversation(conversationId)
      .then(() => {
        void qc.invalidateQueries({ queryKey: qk.messages(conversationId) });
        void qc.invalidateQueries({ queryKey: qk.conversations });
        toast.success(t("dmView.clearChatToast"));
      })
      .catch(() => toast.error(t("dmView.errors.clearChat")));
  };

  // Block / unblock toggles the caller's own block on the peer. The WS
  // conversation.blocked/unblocked echo (queryBridge) reconciles both sides;
  // we also invalidate here so the actor's UI flips without waiting on it.
  const block = useMutation({
    mutationKey: ["dmBlock", conversationId],
    mutationFn: () => {
      if (!conv) return Promise.resolve();
      return conv.blockedByMe ? api.unblockUser(conv.peerId) : api.blockUser(conv.peerId);
    },
    onSuccess: (_data, _vars, _ctx) => {
      void qc.invalidateQueries({ queryKey: qk.conversations });
    },
    onError: () =>
      toast.error(t("dmView.errors.updateBlock.title"), {
        description: t("dmView.errors.updateBlock.description"),
      }),
  });

  /**
   * "Send Call Link" — a joinable link, posted into the chat and, when the
   * sender picks anyone, direct-messaged to org members too.
   *
   * The minting and delivery rules live in lib/deliverCallLink. What stays here
   * is what the view owes the user afterwards — the message in this
   * conversation, the caches that are now stale, and what the toast says.
   */
  const sendLink = useMutation({
    mutationKey: ["dmSendLink", conversationId],
    mutationFn: (alsoTo: string[]) => {
      if (!conv) throw new Error("no conversation");
      return deliverCallLink(api, {
        peerId: conv.peerId,
        peerName: displayNameOf(conv),
        alsoTo,
        origin: config.webBaseUrl,
      });
    },
    onSuccess: ({ link, failed }, alsoTo) => {
      reply.mutate({ body: t("dmView.callLink.messageBody", { link }) });
      void qc.invalidateQueries({ queryKey: qk.calls });
      // Messaging someone for the first time creates the conversation, so the
      // chat list is now out of date.
      if (alsoTo.length > 0) void qc.invalidateQueries({ queryKey: qk.conversations });
      setLinkOpen(false);
      if (failed > 0) {
        toast.error(t("dmView.callLink.failedToast", { failed, total: alsoTo.length }), {
          description: t("dmView.callLink.failedDescription"),
        });
        return;
      }
      toast.success(t("dmView.callLink.sentToast"), {
        description:
          alsoTo.length > 0
            ? t("dmView.callLink.sentDescription.withOthers", { count: alsoTo.length })
            : t("dmView.callLink.sentDescription.aloneOnly"),
      });
    },
    onError: () => toast.error(t("dmView.errors.createCallLink")),
  });

  // Never render peerUsername directly — it is the email local-part. Read
  // before the early return because the derived lists below need it; the helper
  // answers "Unknown user" for a conversation that is briefly missing.
  const peerName = displayNameOf(conv);

  // Tell ScreenshotNotice this chat is the one on screen, so a detected
  // attempt posts its system message here rather than nowhere — see
  // lib/activeThread for why this can't just read useSelectedChat itself.
  // Selected individually, not destructured from the whole store: these
  // setters are stable, so this must not re-render DMView every time some
  // OTHER view's registration changes `thread`.
  const setActiveThread = useActiveThread((s) => s.setActiveThread);
  const clearActiveThread = useActiveThread((s) => s.clearActiveThread);
  const peerId = conv?.peerId;
  useEffect(() => {
    if (!peerId) return;
    const t: ActiveThread = { kind: "chat", conversationId, peerId, peerName };
    setActiveThread(t);
    return () => clearActiveThread(t);
  }, [conversationId, peerId, peerName, setActiveThread, clearActiveThread]);

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
        id: m.id, senderId: m.senderId, body: m.body, at: m.createdAt, kind: m.kind,
        status: m.status, pending: m.id.startsWith("temp:"),
        replyToId: m.replyToId, deletedForAll: m.deletedForAll,
        isForward: m.isForward, forwardPlatform: m.forwardPlatform,
        reactions: reactionsByMessage.get(m.id),
      })),
    [messages, reactionsByMessage],
  );

  // A 1:1 bubble carries no sender name — there are only two people and the
  // side of the thread says which. The surfaces that LIST messages have no
  // sides, so they get the names attached here rather than in the thread, where
  // adding them would start captioning quoted replies that never had captions.
  const threadForTools = useMemo(
    () => thread.map((m) => ({ ...m, senderName: m.senderId === me.id ? t("shared.you") : peerName })),
    [thread, me.id, peerName, t],
  );

  // Searching narrows what the thread draws; it does not touch what is loaded,
  // so "Load older" still widens the set being searched.
  const shown = useMemo(
    () => searchMessages(thread, searchOpen ? query : ""),
    [thread, searchOpen, query],
  );

  const prefs = useConversationPrefs();

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
    send: (body) => reply.mutate({ body, replyToId: takeReply() }),
  });

  if (!conv)
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={<MessageSquare size={24} />}
          title={t("dmView.notFound.title")}
          hint={t("dmView.notFound.hint")}
        />
      </div>
    );
  
  // Calls require the peer to have a live socket (ws-gateway rejects an offline
  // callee with rtc.peer.unreachable). Rather than silently disable the buttons,
  // let the click through and surface a clear note when the peer is offline.
  const isBlocked = conv.blockedByMe || conv.blockedByPeer;
  /** A block in either direction rules out every entry in the call menu, not
   *  just ringing — so all four routes through it say the same thing. */
  const blockedNotice = () => {
    toast(t("dmView.startCall.blockedNotice.title"), {
      description: conv.blockedByMe
        ? t("dmView.startCall.blockedNotice.unblockToCall")
        : t("dmView.startCall.blockedNotice.cannotCall"),
    });
  };
  const startCall = (media: "audio" | "video") => {
    if (isBlocked) {
      blockedNotice();
      return;
    }
    if (!isOnline) {
      toast(t("dmView.startCall.blockedNotice.title"), {
        description: t("dmView.startCall.mustBeOnline", { name: peerName }),
      });
      return;
    }
    // Not a refusal — they can still take it, and only they know whether they
    // should. Saying so first is the difference between an informed interruption
    // and a surprising one.
    if (peerStatus === "busy") {
      toast(t("dmView.startCall.onAnotherCall.title", { name: peerName }), {
        description: t("dmView.startCall.onAnotherCall.description"),
      });
    }
    call.invite(conv.peerId, peerName, media);
  };
  // A link and a diary entry are both asynchronous, so unlike ringing they do
  // not need the peer to be online right now.
  const sendCallLink = () => {
    if (isBlocked) {
      blockedNotice();
      return;
    }
    setLinkOpen(true);
  };
  const scheduleCall = () => {
    if (isBlocked) {
      blockedNotice();
      return;
    }
    setScheduleOpen(true);
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setQuery("");
  };
  /** The loaded conversation as a text file. Bounded by what is loaded, and the
   *  transcript's own header says so — see lib/chatExport. */
  const exportChat = () => {
    exportChatTranscript(threadForTools, { title: peerName, meId: me.id, now: new Date() });
    toast.success(t("dmView.exportedToast", { count: threadForTools.length }));
  };

  return (
    <div className="flex h-full flex-col">
      <header className="relative z-30 flex items-center justify-between border-b border-border/70 bg-surface/60 px-5 py-3 backdrop-blur">
        {/* min-w-0 + truncate: without them a long username pushes the call and
            block buttons off the right edge on a narrow window. */}
        <div className="flex min-w-0 items-center gap-3">
          <button
            onClick={closeChat}
            title={t("dmView.header.backToChats")}
            className="-ml-1 shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg md:hidden"
          >
            <ChevronLeft size={20} />
          </button>
          <Avatar name={peerName} src={avatarUrlOf(conv.peerId)} status={peerStatus} />
          <div className="min-w-0 leading-tight">
            <div className="truncate font-semibold text-fg">{peerName}</div>
            <div
              className={`text-xs ${
                peerStatus === "busy"
                  ? "text-warning"
                  : peerStatus === "online"
                    ? "text-success"
                    : "text-muted"
              }`}
            >
              {peerStatus === "busy"
                ? t("dmView.header.status.busy")
                : peerStatus === "online"
                  ? t("dmView.header.status.online")
                  : t("dmView.header.status.offline")}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <CallMenu
            onVoiceCall={() => startCall("audio")}
            onVideoCall={() => startCall("video")}
            onSendLink={sendCallLink}
            onSchedule={scheduleCall}
            busy={sendLink.isPending}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => block.mutate()}
            disabled={block.isPending}
            title={conv.blockedByMe ? t("dmView.header.unblockTitle") : t("dmView.header.blockTitle")}
          >
            <Ban size={15} /> {conv.blockedByMe ? t("dmView.header.unblockLabel") : t("dmView.header.blockLabel")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => ignore.mutate()}
            disabled={ignore.isPending}
            title={t("dmView.header.removeFromInboxes")}
          >
            <X size={15} /> {t("dmView.header.ignore")}
          </Button>
          <ConversationMenu
            scope="chat"
            onViewProfile={() => nav(`/app/members/${conv.peerId}`)}
            onSearch={() => setSearchOpen(true)}
            onMedia={() => setAssetsOpen(true)}
            muted={prefs.isMuted("chat", conversationId)}
            onToggleMute={() => toggleConversationPref("muted", "chat", conversationId)}
            shortcut={prefs.hasShortcut("chat", conversationId)}
            onToggleShortcut={() => toggleConversationPref("shortcut", "chat", conversationId)}
            onExport={exportChat}
            onSelectMessages={() => { closeSearch(); selection.enter(); }}
            onClearChat={() => setClearChatOpen(true)}
            // Sits alongside two `Button variant="ghost" size="sm"` controls,
            // so it takes their height and radius rather than the bare
            // icon-button styling the channel header's neighbours use.
            className="inline-flex h-8 items-center justify-center rounded-xl px-2 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
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
          placeholder={t("dmView.search.placeholder", { name: peerName })}
        />
      )}
      <ChatThread
        threadId={conversationId}
        messages={shown}
        meId={me.id}
        onLoadOlder={loadOlder}
        loadingOlder={loadingOlder}
        hasOlder={hasOlder}
        // flushStaged, not reply.mutate: Send must emit the attachment tray as
        // well as the text, and must tolerate an empty text (attachments only).
        // Sending drops out of search: a filtered thread would swallow the
        // message the user just sent unless it happened to match the query,
        // which reads as a send that failed.
        onSend={(t) => { media.flushStaged(t); stopTyping(); closeSearch(); }}
        replyTo={replyTo ? messages.find((m) => m.id === replyTo) ?? null : null}
        onCancelReply={() => setReplyTo(null)}
        onReply={(id) => setReplyTo(id)}
        onHide={(id) => hide.mutate(id)}
        onMarkUnread={(id) => {
          const message = messages.find((m) => m.id === id);
          if (message) markUnread.mutate(Math.max(0, message.seq - 1));
        }}
        onDeleteForAll={(id) => removeForAll.mutate(id)}
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
                  toast.error(t("dmView.errors.noneDeletable"));
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
        onType={onType}
        peerTyping={peerTyping}
        peerName={peerName}
        placeholder={t("dmView.composer.placeholder", { name: peerName })}
        disabled={isBlocked}
        notice={
          conv.blockedByMe
            ? t("dmView.notice.blockedByMe")
            : conv.blockedByPeer
              ? t("dmView.notice.blockedByPeer")
              : undefined
        }
        onForwardTo={(id) => {
          const msg = messages.find((m) => m.id === id);
          setForwardTo({ ids: [id], preview: msg?.body ?? "" });
        }}
        onForward={recordForward}
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
        sourceMessageIds={forwardTo?.ids ?? []}
        preview={forwardTo?.preview}
        onDone={selection.exit}
      />
      {/* Mounted only while open: the panel mints one signed link per
          attachment in the thread, and a closed panel doing that on a
          refresh interval is a request nobody asked for. */}
      {assetsOpen && (
        <ChatAssetsSheet
          open
          onClose={() => setAssetsOpen(false)}
          title={peerName}
          messages={threadForTools}
        />
      )}
      {scheduleOpen && (
        <ScheduleCallDialog
          scope={{ kind: "direct", peerId: conv.peerId, peerName }}
          onClose={() => setScheduleOpen(false)}
        />
      )}
      <SendCallLinkDialog
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        peerName={peerName}
        // The peer is posted the link in this chat, so listing them would offer
        // to send it twice.
        exclude={new Set([conv.peerId])}
        busy={sendLink.isPending}
        onSend={(ids) => sendLink.mutate(ids)}
      />
      <ConfirmDialog
        open={clearChatOpen}
        onClose={() => setClearChatOpen(false)}
        title={t("dmView.clearChatDialog.title")}
        message={t("dmView.clearChatDialog.message")}
        confirmLabel={t("dmView.clearChatDialog.confirmLabel")}
        danger
        busy={false}
        onConfirm={() => {
          setClearChatOpen(false);
          clearChat();
        }}
      />
      <ConfirmDialog
        open={bulkDeleteOpen}
        onClose={() => setBulkDeleteOpen(false)}
        title={t("dmView.bulkDeleteDialog.title", { count: deletableCount })}
        message={
          deletableCount === selection.count
            ? t("dmView.bulkDeleteDialog.messageAll")
            : t("dmView.bulkDeleteDialog.messagePartial", {
                remaining: selection.count - deletableCount,
                total: selection.count,
                deletable: deletableCount,
              })
        }
        confirmLabel={t("dmView.bulkDeleteDialog.confirmLabel")}
        danger
        busy={bulkDelete.isPending}
        onConfirm={() => bulkDelete.mutate(selectedMessages.map((m) => m.id))}
      />
    </div>
  );
}
