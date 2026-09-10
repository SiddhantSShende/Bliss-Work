import { useMemo, useState } from 'react';
import { ArrowLeft } from 'lucide-react-native';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { ChannelMessageDTO } from '@taskboard/shared';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { useSession } from '@taskboard/app/store/session';
import { useChannelMessages, useSendChannelMessage } from '../../hooks/useChannels';
import { MessageBubble } from '../../components/MessageBubble';
import { Composer } from '../../components/Composer';
import { spacing, type ThemeColors } from '../../constants/theme';
import type { MoreStackParamList } from '../../navigation/types';
import { useThemeColors } from '../../theme/ThemeProvider';

type Props = NativeStackScreenProps<MoreStackParamList, 'ChannelConversation'>;

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Channel thread — reuses the exact `MessageBubble`/`Composer` primitives
 *  Chats uses, since `channelMessages()`/`sendChannelMessage()` mirror the
 *  DM API closely (see useChannels.ts). No read-receipt ticks: unlike
 *  `MessageDTO`, `ChannelMessageDTO` carries no per-viewer `status` field —
 *  `MessageBubble` already only renders ticks when `message.status` is set. */
export function ChannelConversationScreen({ route, navigation }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { channelId, channelName } = route.params;
  const insets = useSafeAreaInsets();
  const { rtcAvailable } = useRuntime();
  const me = useSession((s) => s.user);
  const { messages, isLoading, hasNextPage, fetchNextPage, isFetchingNextPage } = useChannelMessages(channelId);
  const send = useSendChannelMessage(channelId);
  const [draft, setDraft] = useState('');

  const onSend = () => {
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    send.mutate(body);
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
        <Text style={styles.headerTitle} numberOfLines={1}>
          # {channelName}
        </Text>
        <View style={{ width: 22 }} />
      </View>

      {isLoading ? (
        <ActivityIndicator color={colors.accent} style={styles.spinner} />
      ) : (
        <FlatList<ChannelMessageDTO>
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
    spinner: { marginTop: spacing['2xl'] },
    messages: { paddingVertical: spacing.md },
  });
}
