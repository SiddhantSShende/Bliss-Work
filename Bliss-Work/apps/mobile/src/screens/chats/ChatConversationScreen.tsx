import { useMemo, useState } from 'react';
import { ArrowLeft, MoreVertical, Phone, Video } from 'lucide-react-native';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MessageDTO } from '@taskboard/shared';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { useSession } from '@taskboard/app/store/session';
import { useConversations } from '../../hooks/useConversations';
import { useMessages } from '../../hooks/useMessages';
import { useSendMessage } from '../../hooks/useSendMessage';
import { usePresence } from '../../hooks/usePresence';
import { useScheduleMeeting } from '../../hooks/useMeetings';
import { Avatar } from '../../components/Avatar';
import { MessageBubble } from '../../components/MessageBubble';
import { Composer } from '../../components/Composer';
import { spacing, type ThemeColors } from '../../constants/theme';
import type { ChatsStackParamList } from '../../navigation/types';
import { useThemeColors } from '../../theme/ThemeProvider';
import { ChatRowMenu } from './ChatRowMenu';

type Props = NativeStackScreenProps<ChatsStackParamList, 'ChatConversation'>;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function ChatConversationScreen({ route, navigation }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { conversationId, peerId, peerName } = route.params;
  const insets = useSafeAreaInsets();
  const { config, rtcAvailable } = useRuntime();
  const me = useSession((s) => s.user);
  const online = usePresence([peerId]);
  // Looked up from the already-cached Chats list rather than carried as a
  // route param — this screen is also reachable from a brand-new
  // conversation (NewChatScreen) that isn't in that list yet, in which case
  // "not blocked" is the correct default (a conversation that didn't exist a
  // moment ago cannot already be blocked).
  const { data: conversations } = useConversations();
  const blockedByMe = conversations?.find((c) => c.id === conversationId)?.blockedByMe ?? false;
  const { messages, isLoading, hasNextPage, fetchNextPage, isFetchingNextPage } = useMessages(conversationId);
  const send = useSendMessage(conversationId);
  const scheduleMeeting = useScheduleMeeting();
  const [draft, setDraft] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);

  const onSend = () => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    send.mutate(body);
  };

  const startCall = async (media: 'audio' | 'video') => {
    const call = await scheduleMeeting.mutateAsync({ media, inviteeIds: [peerId] });
    void Linking.openURL(`${config.webBaseUrl}/call/${call.id}`);
  };

  return (
    <KeyboardAvoidingView
      style={[styles.flex, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
    >
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
        <Pressable onPress={() => void startCall('audio')} hitSlop={8} style={styles.headerIcon}>
          <Phone size={20} color={colors.accent} />
        </Pressable>
        <Pressable onPress={() => void startCall('video')} hitSlop={8} style={styles.headerIcon}>
          <Video size={20} color={colors.accent} />
        </Pressable>
        <Pressable onPress={() => setMenuOpen(true)} hitSlop={8} style={styles.headerIcon}>
          <MoreVertical size={20} color={colors.fg} />
        </Pressable>
      </View>

      {isLoading ? (
        <ActivityIndicator color={colors.accent} style={styles.spinner} />
      ) : (
        <FlatList<MessageDTO>
          data={[...messages].reverse()}
          keyExtractor={(m) => m.id}
          inverted
          contentContainerStyle={styles.messages}
          onEndReached={() => hasNextPage && !isFetchingNextPage && void fetchNextPage()}
          onEndReachedThreshold={0.4}
          ListFooterComponent={isFetchingNextPage ? <ActivityIndicator color={colors.accent} /> : null}
          renderItem={({ item }) => (
            <MessageBubble message={item} mine={item.senderId === me?.id} time={formatTime(item.createdAt)} />
          )}
        />
      )}

      <Composer
        value={draft}
        onChangeText={setDraft}
        onSend={onSend}
        sending={send.isPending}
        attachAvailable={rtcAvailable}
      />

      <ChatRowMenu
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        conversationId={conversationId}
        peerId={peerId}
        blockedByMe={blockedByMe}
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
    spinner: { marginTop: spacing['2xl'] },
    messages: { paddingVertical: spacing.md },
  });
}
