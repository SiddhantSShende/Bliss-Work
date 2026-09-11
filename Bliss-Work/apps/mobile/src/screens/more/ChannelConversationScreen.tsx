import { useMemo, useRef, useState } from 'react';
import { ArrowLeft, Info, MoreVertical, Trash2, X } from 'lucide-react-native';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { ChannelMessageDTO, UserDTO } from '@taskboard/shared';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { useSession } from '@taskboard/app/store/session';
import { attachmentIdsOf, parseChatEnvelope, readablePrefix, type MediaItem } from '@taskboard/app/chatEnvelope';
import { useAttachmentLinks } from '@taskboard/app/lib/useAttachmentLinks';
import {
  useChannelMessages,
  useChannelReactions,
  useChannels,
  useDeleteChannelMessages,
  useHideChannelMessage,
  useSendChannelMessage,
  useSetChannelMessagePin,
  useSetChannelReaction,
} from '../../hooks/useChannels';
import { useForwardMessage } from '../../hooks/useMessages';
import { useMutedConversations } from '../../hooks/useMutedConversations';
import { EmojiPickerModal } from '../../components/EmojiPickerModal';
import { MessageRow } from '../../components/MessageRow';
import { Composer } from '../../components/Composer';
import { SearchInput } from '../../components/SearchInput';
import { spacing, type ThemeColors } from '../../constants/theme';
import type { MoreStackParamList } from '../../navigation/types';
import { useThemeColors } from '../../theme/ThemeProvider';
import { ChatHeaderMenu, type ChatHeaderMenuAnchor } from '../chats/ChatHeaderMenu';
import { ChatMediaLinksModal } from '../chats/ChatMediaLinksModal';
import { ForwardMessageSheet } from '../chats/ForwardMessageSheet';
import { MessageActionSheet } from '../chats/MessageActionSheet';
import { ChannelRowMenu } from './ChannelRowMenu';

type Props = NativeStackScreenProps<MoreStackParamList, 'ChannelConversation'>;

const URL_PATTERN = /https?:\/\/[^\s]+/gi;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Channel thread — brought to feature parity with ChatConversationScreen
 *  (header dropdown, reactions, long-press message actions, search,
 *  selection) in this pass; see that screen for the shared shape (this file
 *  mirrors its structure deliberately rather than a forced shared hook —
 *  the two screens' data/permission model differ enough that the codebase
 *  already keeps their send/message hooks separate, same reasoning here). */
export function ChannelConversationScreen({ route, navigation }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { channelId, channelName } = route.params;
  const insets = useSafeAreaInsets();
  const { rtcAvailable } = useRuntime();
  const me = useSession((s) => s.user);
  const { data: channels } = useChannels();
  const myRole = channels?.find((c) => c.id === channelId)?.myRole ?? '';
  const canManage = myRole === 'owner' || myRole === 'admin';
  const { messages, isLoading, hasNextPage, fetchNextPage, isFetchingNextPage, data } = useChannelMessages(channelId);
  const reactionsFor = useChannelReactions(channelId, (data?.pageParams as (number | undefined)[] | undefined) ?? [undefined]);
  const setReaction = useSetChannelReaction(channelId);
  const send = useSendChannelMessage(channelId);
  const deleteMessages = useDeleteChannelMessages(channelId);
  const hideMessage = useHideChannelMessage(channelId);
  const setPin = useSetChannelMessagePin(channelId);
  const forwardMessage = useForwardMessage();
  const { isMuted, toggle: toggleMute } = useMutedConversations();
  const [draft, setDraft] = useState('');

  const moreButtonRef = useRef<View>(null);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [headerMenuAnchor, setHeaderMenuAnchor] = useState<ChatHeaderMenuAnchor | null>(null);
  const [rowMenuOpen, setRowMenuOpen] = useState(false);
  const [mediaLinksOpen, setMediaLinksOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [actionSheetFor, setActionSheetFor] = useState<ChannelMessageDTO | null>(null);
  const [emojiPickerFor, setEmojiPickerFor] = useState<ChannelMessageDTO | null>(null);
  const [forwardFor, setForwardFor] = useState<ChannelMessageDTO | null>(null);
  const [replyTarget, setReplyTarget] = useState<ChannelMessageDTO | null>(null);

  // Wired here for the first time — channel bubbles previously rendered
  // attachments with no resolver at all (always the loading spinner state).
  // Same batching rationale as ChatConversationScreen's own copy of this.
  const attachmentIds = useMemo(
    () => [...new Set(messages.flatMap((m) => attachmentIdsOf(parseChatEnvelope(m.body))))],
    [messages],
  );
  const { urlFor, isResolved } = useAttachmentLinks(attachmentIds);

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
      if (parseChatEnvelope(m.body)) continue;
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

  const onSend = () => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    const replyToId = replyTarget?.id;
    setReplyTarget(null);
    send.mutate(replyToId ? { body, replyToId } : body);
  };

  const openHeaderMenu = () => {
    if (headerMenuOpen) {
      setHeaderMenuOpen(false);
      return;
    }
    moreButtonRef.current?.measureInWindow((x, y, width, height) => {
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

  const canDeleteAll = (message: ChannelMessageDTO) => message.senderId === me?.id || canManage;

  const confirmDeleteSelected = () => {
    if (selectedIds.size === 0) return;
    Alert.alert(
      `Delete ${selectedIds.size} message${selectedIds.size > 1 ? 's' : ''}?`,
      "This can't be undone.",
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

  const toggleReaction = (message: ChannelMessageDTO, emoji: string, on: boolean) => {
    setReaction.mutate({ messageId: message.id, emoji, on });
  };

  const confirmDeleteForAll = (message: ChannelMessageDTO) => {
    Alert.alert('Delete for everyone?', "This can't be undone.", [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteMessages.mutate([message.id]) },
    ]);
  };

  const onPickForwardTarget = async (user: UserDTO) => {
    if (!forwardFor) return;
    setForwardFor(null);
    await forwardMessage.mutateAsync({ messageId: forwardFor.id, targetUserId: user.id });
  };

  return (
    <KeyboardAvoidingView
      style={[styles.flex, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
    >
      {selectionMode ? (
        <View style={styles.header}>
          <Pressable onPress={cancelSelection} hitSlop={8}>
            <X size={22} color={colors.fg} />
          </Pressable>
          <Text style={[styles.headerTitle, styles.selectionCount]}>{selectedIds.size} selected</Text>
          <Pressable onPress={confirmDeleteSelected} disabled={selectedIds.size === 0} hitSlop={8}>
            <Trash2 size={20} color={selectedIds.size === 0 ? colors.muted : colors.danger} />
          </Pressable>
        </View>
      ) : (
        <View style={styles.header}>
          <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
            <ArrowLeft size={22} color={colors.fg} />
          </Pressable>
          <Text style={styles.headerTitle} numberOfLines={1}>
            # {channelName}
          </Text>
          <View style={styles.headerActions}>
            <Pressable onPress={() => navigation.navigate('ChannelDetail', { channelId, channelName })} hitSlop={8} style={styles.headerIcon}>
              <Info size={20} color={colors.fg} />
            </Pressable>
            <Pressable ref={moreButtonRef} onPress={openHeaderMenu} hitSlop={8} style={styles.headerIcon}>
              <MoreVertical size={20} color={colors.fg} />
            </Pressable>
          </View>
        </View>
      )}

      {searchOpen ? (
        <View style={styles.searchWrap}>
          <View style={styles.searchInput}>
            <SearchInput value={searchQuery} onChangeText={setSearchQuery} placeholder="Search in this channel..." />
          </View>
          <Pressable onPress={closeSearch} hitSlop={8}>
            <X size={20} color={colors.muted} />
          </Pressable>
        </View>
      ) : null}

      {isLoading ? (
        <ActivityIndicator color={colors.accent} style={styles.spinner} />
      ) : (
        <FlatList<ChannelMessageDTO>
          data={[...displayedMessages].reverse()}
          keyExtractor={(m) => m.id}
          inverted
          contentContainerStyle={styles.messages}
          onEndReached={() => hasNextPage && !isFetchingNextPage && void fetchNextPage()}
          onEndReachedThreshold={0.4}
          ListFooterComponent={isFetchingNextPage ? <ActivityIndicator color={colors.accent} /> : null}
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
              Replying to {replyTarget.senderId === me?.id ? 'yourself' : replyTarget.senderDisplayName || replyTarget.senderUsername}
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

      {!selectionMode ? (
        <Composer value={draft} onChangeText={setDraft} onSend={onSend} sending={send.isPending} attachAvailable={rtcAvailable} />
      ) : null}

      <ChatHeaderMenu
        visible={headerMenuOpen}
        anchor={headerMenuAnchor}
        onClose={() => setHeaderMenuOpen(false)}
        onViewProfile={() => navigation.navigate('ChannelDetail', { channelId, channelName })}
        onSearch={() => setSearchOpen(true)}
        onMediaLinksDocs={() => setMediaLinksOpen(true)}
        onSelectMessages={() => setSelectionMode(true)}
        onMuteNotifications={() => toggleMute(channelId)}
        onMore={() => setRowMenuOpen(true)}
        muted={isMuted(channelId)}
      />

      <ChannelRowMenu
        visible={rowMenuOpen}
        onClose={() => setRowMenuOpen(false)}
        channelId={channelId}
        onLeft={() => navigation.goBack()}
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
        canPin={canManage}
        isPinned={actionSheetFor?.pinned}
        canDeleteForAll={Boolean(actionSheetFor && canDeleteAll(actionSheetFor))}
        onQuickReact={(emoji) => {
          if (!actionSheetFor) return;
          const already = reactionsFor(actionSheetFor.id).some((r) => r.emoji === emoji && r.mine);
          toggleReaction(actionSheetFor, emoji, !already);
        }}
        onOpenFullPicker={() => setEmojiPickerFor(actionSheetFor)}
        onReply={() => setReplyTarget(actionSheetFor)}
        onForward={() => setForwardFor(actionSheetFor)}
        onSelect={() => {
          if (!actionSheetFor) return;
          setSelectionMode(true);
          setSelectedIds(new Set([actionSheetFor.id]));
        }}
        onTogglePin={() => actionSheetFor && setPin.mutate({ messageId: actionSheetFor.id, on: !actionSheetFor.pinned })}
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

      <ForwardMessageSheet
        visible={Boolean(forwardFor)}
        onClose={() => setForwardFor(null)}
        onPick={(user) => void onPickForwardTarget(user)}
      />
    </KeyboardAvoidingView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      backgroundColor: colors.surface,
    },
    headerTitle: { flex: 1, fontSize: 15, fontWeight: '700', color: colors.fg, textAlign: 'center' },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    headerIcon: { padding: 2 },
    selectionCount: { textAlign: 'left' },
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
