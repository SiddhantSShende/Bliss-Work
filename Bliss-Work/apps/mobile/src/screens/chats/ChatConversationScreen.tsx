import { useCallback, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { ArrowLeft, MoreVertical, Phone, Trash2, X } from 'lucide-react-native';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import type { MessageDTO, UserDTO } from '@taskboard/shared';
import { useSession } from '@taskboard/app/store/session';
import { copyableText, copyMessageText } from '../../lib/copyMessage';
import { attachmentIdsOf, parseChatEnvelope, readablePrefix, type MediaItem } from '@taskboard/app/chatEnvelope';
import { useAttachmentLinks } from '@taskboard/app/lib/useAttachmentLinks';
import { useConversations } from '../../hooks/useConversations';
import { useDeleteMessages, useForwardMessage, useHideMessage, useMessages } from '../../hooks/useMessages';
import { ErrorState, LoadingState } from '../../components/QueryState';
import { useReactions, useSetReaction } from '../../hooks/useReactions';
import { useSendMessage } from '../../hooks/useSendMessage';
import { useChatAttachments } from '../../hooks/useChatAttachments';
import { UploadStrip } from '../../components/UploadStrip';
import { usePresence } from '../../hooks/usePresence';
import { useMutedConversations } from '../../hooks/useMutedConversations';
import { useSendCallLink } from '../../hooks/useMeetings';
import { useCalls } from '../../calls/CallProvider';
import { clearThreadFocused, setThreadFocused } from '../../calls/messageNotifications';
import { protectThread } from '../../security/screenSecurity';
import { Avatar } from '../../components/Avatar';
import { EmojiPickerModal } from '../../components/EmojiPickerModal';
import { MessageRow } from '../../components/MessageRow';
import { ChatKeyboardAvoider } from '../../components/ChatKeyboardAvoider';
import { Composer } from '../../components/Composer';
import { SearchInput } from '../../components/SearchInput';
import { spacing, type ThemeColors } from '../../constants/theme';
import type { AppTabParamList, ChatsStackParamList } from '../../navigation/types';
import { useThemeColors } from '../../theme/ThemeProvider';
import { ChatRowMenu } from './ChatRowMenu';
import { CallOptionsMenu } from './CallOptionsMenu';
import { ChatHeaderMenu, type ChatHeaderMenuAnchor } from './ChatHeaderMenu';
import { ForwardMessageSheet } from './ForwardMessageSheet';
import { LocationShareSheet } from './LocationShareSheet';
import { MessageActionSheet } from './MessageActionSheet';
import { PeerProfileModal } from './PeerProfileModal';
import { ChatMediaLinksModal } from './ChatMediaLinksModal';

type Props = NativeStackScreenProps<ChatsStackParamList, 'ChatConversation'>;

const URL_PATTERN = /https?:\/\/[^\s]+/gi;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function ChatConversationScreen({ route, navigation }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { conversationId, peerId, peerName } = route.params;
  const insets = useSafeAreaInsets();
  const { startDirectCall } = useCalls();
  const me = useSession((s) => s.user);
  const online = usePresence([peerId]);
  // While this exact conversation is on screen, a new message in it should
  // not also raise an OS notification for what the user is already reading.
  useFocusEffect(
    useCallback(() => {
      const ref = { kind: 'chat' as const, id: conversationId };
      setThreadFocused(ref);
      // Screenshots of this conversation are blocked (and reported) while it is on screen.
      const release = protectThread({ kind: 'chat', conversationId, peerId });
      return () => {
        clearThreadFocused(ref);
        release();
      };
    }, [conversationId, peerId]),
  );
  // Looked up from the already-cached Chats list rather than carried as a
  // route param — this screen is also reachable from a brand-new
  // conversation (NewChatScreen) that isn't in that list yet, in which case
  // "not blocked" is the correct default (a conversation that didn't exist a
  // moment ago cannot already be blocked).
  const { data: conversations } = useConversations();
  const blockedByMe = conversations?.find((c) => c.id === conversationId)?.blockedByMe ?? false;
  const { messages, isLoading, isError, error, refetch, hasNextPage, fetchNextPage, isFetchingNextPage, data } = useMessages(conversationId);
  const reactionsFor = useReactions(conversationId, (data?.pageParams as (number | undefined)[] | undefined) ?? [undefined]);
  const setReaction = useSetReaction(conversationId);
  const send = useSendMessage(conversationId);
  const deleteMessages = useDeleteMessages(conversationId);
  const hideMessage = useHideMessage(conversationId);
  const forwardMessage = useForwardMessage();
  const sendCallLink = useSendCallLink();
  const { isMuted, toggle: toggleMute } = useMutedConversations();
  const [draft, setDraft] = useState('');

  // "..." → ChatHeaderMenu (the floating dropdown), which either opens one of
  // the sheets/modes below or, for "More", hands off to the existing
  // ChatRowMenu (Ignore/Clear chat/Block — unchanged, still `menuOpen`).
  const moreButtonRef = useRef<any>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [headerMenuAnchor, setHeaderMenuAnchor] = useState<ChatHeaderMenuAnchor | null>(null);
  const [callMenuOpen, setCallMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [mediaLinksOpen, setMediaLinksOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Long-press → MessageActionSheet, then whichever follow-up it opens.
  const [actionSheetFor, setActionSheetFor] = useState<MessageDTO | null>(null);
  const [emojiPickerFor, setEmojiPickerFor] = useState<MessageDTO | null>(null);
  const [forwardFor, setForwardFor] = useState<MessageDTO | null>(null);
  const [replyTarget, setReplyTarget] = useState<MessageDTO | null>(null);

  // Batched once for the whole loaded page rather than per-bubble — see
  // useAttachmentLinks' own doc for why minting per-message would multiply
  // the request count for no benefit.
  const attachmentIds = useMemo(
    () => [...new Set(messages.flatMap((m) => attachmentIdsOf(parseChatEnvelope(m.body))))],
    [messages],
  );
  const { urlFor, isResolved } = useAttachmentLinks(attachmentIds);

  // "Media, Links & Docs" and Search both work over what's already loaded —
  // the same "searches what the reader has" honesty as web's ChatSearchBar
  // (docs/SEARCH-DECISION.md: encrypted bodies rule out a real server-side
  // search), not a second fetch.
  const mediaFiles = useMemo(() => {
    const items: MediaItem[] = [];
    for (const m of messages) {
      const envelope = parseChatEnvelope(m.body);
      if (envelope?.kind === 'media') items.push(...envelope.items);
    }
    return items;
  }, [messages]);

  const chatLinks = useMemo(() => {
    const found = new Set<string>();
    for (const m of messages) {
      if (parseChatEnvelope(m.body)) continue; // structured envelopes carry no user-typed links
      readablePrefix(m.body)
        .match(URL_PATTERN)
        ?.forEach((url) => found.add(url));
    }
    return [...found];
  }, [messages]);

  const displayedMessages = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!searchOpen || !query) return messages;
    return messages.filter((m) => readablePrefix(m.body).toLowerCase().includes(query));
  }, [messages, searchOpen, searchQuery]);

  const sendBody = (body: string) => send.mutateAsync(body);
  const { pickFiles, pickMedia, uploads, retry: retryUpload, dismiss: dismissUpload } = useChatAttachments(conversationId, sendBody, 'conversation');
  const [locationOpen, setLocationOpen] = useState(false);

  const onSend = () => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    const replyToId = replyTarget?.id;
    setReplyTarget(null);
    send.mutate(replyToId ? { body, replyToId } : body);
  };

  // In-app 1:1 call over the same ring protocol web/desktop use — the app's
  // own call screen, never a browser.
  const startCall = (media: 'audio' | 'video') => startDirectCall(peerId, peerName, media);

  // Mints a fresh meeting + join link and posts it as a message, rather than
  // starting a call the sender immediately leaves — same shape as web's
  // "send call link" in DMView.tsx.
  const sendCallLinkMessage = async () => {
    try {
      const link = await sendCallLink.mutateAsync({ peerId, peerName });
      await send.mutateAsync(`Join my call: ${link}`);
    } catch {
      // Failure is already surfaced by useSendCallLink's own Alert.
    }
  };

  const openScheduleCall = () => {
    navigation
      .getParent<BottomTabNavigationProp<AppTabParamList>>()
      ?.navigate('Meetings', { screen: 'ScheduleMeeting', params: { inviteeId: peerId, inviteeName: peerName } });
  };

  const openHeaderMenu = () => {
    if (headerMenuOpen) {
      setHeaderMenuOpen(false);
      return;
    }
    moreButtonRef.current?.measureInWindow((x: number, y: number, width: number, height: number) => {
      setHeaderMenuAnchor({ top: y + height + spacing.xs, right: Dimensions.get('window').width - (x + width) });
      setHeaderMenuOpen(true);
    });
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery('');
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const cancelSelection = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  };

  const confirmDeleteSelected = () => {
    if (selectedIds.size === 0) return;
    Alert.alert(
      `Delete ${selectedIds.size} message${selectedIds.size > 1 ? 's' : ''}?`,
      "You can only delete messages you sent. This can't be undone.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            deleteMessages.mutate([...selectedIds]);
            cancelSelection();
          },
        },
      ],
    );
  };

  const toggleReaction = (message: MessageDTO, emoji: string, on: boolean) => {
    setReaction.mutate({ messageId: message.id, emoji, on });
  };

  const confirmDeleteForAll = (message: MessageDTO) => {
    Alert.alert('Delete for everyone?', "This can't be undone.", [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteMessages.mutate([message.id]) },
    ]);
  };

  const onForwardTo = async (users: UserDTO[]) => {
    if (!forwardFor) return;
    const messageId = forwardFor.id;
    setForwardFor(null);
    await forwardMessage.mutateAsync({ messageId, targetUserIds: users.map((u) => u.id) }).catch(() => undefined);
  };

  return (
    <ChatKeyboardAvoider style={[styles.flex, { paddingTop: insets.top }]} iosKeyboardVerticalOffset={insets.top}>
      {selectionMode ? (
        <View style={styles.header}>
          <Pressable onPress={cancelSelection} hitSlop={8}>
            <X size={22} color={colors.fg} />
          </Pressable>
          <Text style={[styles.headerName, styles.selectionCount]}>{selectedIds.size} selected</Text>
          <Pressable onPress={confirmDeleteSelected} disabled={selectedIds.size === 0} hitSlop={8} style={styles.headerIcon}>
            <Trash2 size={20} color={selectedIds.size === 0 ? colors.muted : colors.danger} />
          </Pressable>
        </View>
      ) : (
        <View style={styles.header}>
          <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
            <ArrowLeft size={22} color={colors.fg} />
          </Pressable>
          <Avatar name={peerName} size={34} online={online.has(peerId)} />
          <View style={styles.headerText}>
            <Text style={styles.headerName} numberOfLines={1}>
              {peerName}
            </Text>
            <Text style={styles.headerStatus}>{online.has(peerId) ? 'Online' : 'Offline'}</Text>
          </View>
          <Pressable onPress={() => setCallMenuOpen((v) => !v)} hitSlop={8} style={styles.headerIcon}>
            <Phone size={20} color={colors.accent} />
          </Pressable>
          <Pressable ref={moreButtonRef} onPress={openHeaderMenu} hitSlop={8} style={styles.headerIcon}>
            <MoreVertical size={20} color={colors.fg} />
          </Pressable>
        </View>
      )}

      {searchOpen ? (
        <View style={styles.searchWrap}>
          <View style={styles.searchInput}>
            <SearchInput value={searchQuery} onChangeText={setSearchQuery} placeholder="Search in this chat..." />
          </View>
          <Pressable onPress={closeSearch} hitSlop={8}>
            <X size={20} color={colors.muted} />
          </Pressable>
        </View>
      ) : null}

      {isLoading ? (
        <LoadingState label="Loading messages..." />
      ) : isError && messages.length === 0 ? (
        <ErrorState title="Unable to load messages" error={error} onRetry={() => void refetch()} />
      ) : (
        <FlatList<MessageDTO>
          data={[...displayedMessages].reverse()}
          keyExtractor={(m) => m.id}
          inverted
          contentContainerStyle={styles.messages}
          onEndReached={() => hasNextPage && !isFetchingNextPage && void fetchNextPage()}
          onEndReachedThreshold={0.4}
          ListFooterComponent={isFetchingNextPage ? <ActivityIndicator color={colors.accent} /> : undefined}
          renderItem={({ item }) => (
            <MessageRow
              message={item}
              mine={item.senderId === me?.id}
              time={formatTime(item.createdAt)}
              urlFor={urlFor}
              isResolved={isResolved}
              reactions={reactionsFor(item.id)}
              onToggleReaction={(emoji, on) => toggleReaction(item, emoji, on)}
              reactionsDisabled={setReaction.isPending}
              selectionMode={selectionMode}
              selected={selectedIds.has(item.id)}
              onToggleSelected={() => toggleSelected(item.id)}
              onLongPress={() => setActionSheetFor(item)}
            />
          )}
        />
      )}

      {replyTarget && !selectionMode ? (
        <View style={styles.replyBanner}>
          <View style={styles.replyBannerText}>
            <Text style={styles.replyBannerLabel}>
              Replying to {replyTarget.senderId === me?.id ? 'yourself' : peerName}
            </Text>
            <Text style={styles.replyBannerBody} numberOfLines={1}>
              {readablePrefix(replyTarget.body)}
            </Text>
          </View>
          <Pressable onPress={() => setReplyTarget(null)} hitSlop={8}>
            <X size={18} color={colors.muted} />
          </Pressable>
        </View>
      ) : null}

      {!selectionMode ? <UploadStrip uploads={uploads} onRetry={retryUpload} onDismiss={dismissUpload} /> : null}

      {!selectionMode ? (
        <Composer
          value={draft}
          onChangeText={setDraft}
          onSend={onSend}
          sending={send.isPending}
          attachAvailable
          onAttach={() => void pickFiles()}
          onAttachMedia={() => void pickMedia()}
          onShareLocation={() => setLocationOpen(true)}
        />
      ) : null}

      <ChatRowMenu
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        conversationId={conversationId}
        peerId={peerId}
        blockedByMe={blockedByMe}
      />

      <CallOptionsMenu
        visible={callMenuOpen}
        onClose={() => setCallMenuOpen(false)}
        onVoiceCall={() => startCall('audio')}
        onVideoCall={() => startCall('video')}
        onSendCallLink={() => void sendCallLinkMessage()}
        onScheduleCall={openScheduleCall}
      />

      <ChatHeaderMenu
        visible={headerMenuOpen}
        anchor={headerMenuAnchor}
        onClose={() => setHeaderMenuOpen(false)}
        onViewProfile={() => setProfileOpen(true)}
        onSearch={() => setSearchOpen(true)}
        onMediaLinksDocs={() => setMediaLinksOpen(true)}
        onSelectMessages={() => setSelectionMode(true)}
        onMuteNotifications={() => toggleMute(conversationId)}
        onMore={() => setMenuOpen(true)}
        muted={isMuted(conversationId)}
      />

      <PeerProfileModal
        visible={profileOpen}
        onClose={() => setProfileOpen(false)}
        peerName={peerName}
        online={online.has(peerId)}
      />

      <ChatMediaLinksModal
        visible={mediaLinksOpen}
        onClose={() => setMediaLinksOpen(false)}
        files={mediaFiles}
        links={chatLinks}
        urlFor={urlFor}
      />

      <MessageActionSheet
        visible={Boolean(actionSheetFor)}
        onClose={() => setActionSheetFor(null)}
        mine={actionSheetFor?.senderId === me?.id}
        canDeleteForAll={actionSheetFor?.senderId === me?.id}
        onQuickReact={(emoji) => {
          if (!actionSheetFor) return;
          const already = reactionsFor(actionSheetFor.id).some((r) => r.emoji === emoji && r.mine);
          toggleReaction(actionSheetFor, emoji, !already);
        }}
        onOpenFullPicker={() => setEmojiPickerFor(actionSheetFor)}
        onReply={() => setReplyTarget(actionSheetFor)}
        onForward={() => setForwardFor(actionSheetFor)}
        onCopy={
          actionSheetFor && copyableText(actionSheetFor.body, actionSheetFor.deletedForAll)
            ? () => void copyMessageText(copyableText(actionSheetFor.body, actionSheetFor.deletedForAll)!)
            : undefined
        }
        onSelect={() => {
          if (!actionSheetFor) return;
          setSelectionMode(true);
          setSelectedIds(new Set([actionSheetFor.id]));
        }}
        onDeleteForMe={() => actionSheetFor && hideMessage.mutate(actionSheetFor.id)}
        onDeleteForAll={() => actionSheetFor && confirmDeleteForAll(actionSheetFor)}
      />

      <EmojiPickerModal
        visible={Boolean(emojiPickerFor)}
        onClose={() => setEmojiPickerFor(null)}
        onSelect={(emoji) => {
          if (!emojiPickerFor) return;
          const already = reactionsFor(emojiPickerFor.id).some((r) => r.emoji === emoji && r.mine);
          toggleReaction(emojiPickerFor, emoji, !already);
        }}
      />

      <LocationShareSheet visible={locationOpen} onClose={() => setLocationOpen(false)} sendBody={sendBody} />

      <ForwardMessageSheet
        visible={Boolean(forwardFor)}
        onClose={() => setForwardFor(null)}
        onForward={onForwardTo}
      />
    </ChatKeyboardAvoider>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      backgroundColor: colors.surface,
    },
    headerText: { flex: 1 },
    headerName: { fontSize: 15, fontWeight: '700', color: colors.fg },
    headerStatus: { fontSize: 11, color: colors.muted },
    headerIcon: { padding: 2 },
    selectionCount: { flex: 1 },
    searchWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      backgroundColor: colors.surface,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    searchInput: { flex: 1 },
    spinner: { marginTop: spacing['2xl'] },
    messages: { paddingVertical: spacing.md },
    replyBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      backgroundColor: colors.surface2,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    replyBannerText: { flex: 1, gap: 1, borderLeftWidth: 2, borderLeftColor: colors.accent, paddingLeft: spacing.sm },
    replyBannerLabel: { fontSize: 12, fontWeight: '700', color: colors.accent },
    replyBannerBody: { fontSize: 13, color: colors.muted },
  });
}
