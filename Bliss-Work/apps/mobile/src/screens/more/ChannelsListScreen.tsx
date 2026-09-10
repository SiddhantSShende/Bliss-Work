import { useMemo, useState } from 'react';
import { ArrowLeft, Hash } from 'lucide-react-native';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useChannels } from '../../hooks/useChannels';
import { SearchInput } from '../../components/SearchInput';
import { EmptyState } from '../../components/EmptyState';
import { Badge } from '../../components/Badge';
import { timeAgo } from '../../lib/timeAgo';
import { spacing, type ThemeColors } from '../../constants/theme';
import type { MoreStackParamList } from '../../navigation/types';
import { useThemeColors } from '../../theme/ThemeProvider';

type Props = NativeStackScreenProps<MoreStackParamList, 'Channels'>;

/** Group channels — lighter-tier list reusing Chats' message/composer
 *  primitives on the conversation screen (see ChannelConversationScreen). */
export function ChannelsListScreen({ navigation }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { data: channels = [], isLoading, isRefetching, refetch } = useChannels();
  const [query, setQuery] = useState('');

  const filtered = useMemo(
    () => channels.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase())),
    [channels, query],
  );

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
          <ArrowLeft size={22} color={colors.fg} />
        </Pressable>
        <Text style={styles.headerTitle}>Channels</Text>
        <View style={{ width: 22 }} />
      </View>

      <View style={styles.searchWrap}>
        <SearchInput value={query} onChangeText={setQuery} placeholder="Search channels..." />
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(c) => c.id}
        refreshing={isRefetching}
        onRefresh={() => void refetch()}
        contentContainerStyle={styles.list}
        ListEmptyComponent={!isLoading ? <EmptyState icon={Hash} title="No channels yet" /> : null}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => navigation.navigate('ChannelConversation', { channelId: item.id, channelName: item.name })}
            style={styles.row}
          >
            <View style={styles.iconWrap}>
              <Hash size={18} color={colors.accent} />
            </View>
            <View style={styles.rowText}>
              <View style={styles.rowTop}>
                <Text style={styles.name} numberOfLines={1}>
                  {item.name}
                </Text>
                {item.lastMessageAt ? <Text style={styles.time}>{timeAgo(item.lastMessageAt)}</Text> : null}
              </View>
              <Text style={styles.preview} numberOfLines={1}>
                {item.lastMessageSender ? `${item.lastMessageSender}: ` : ''}
                {item.cleared ? '' : item.lastMessage ?? `${item.memberCount} members`}
              </Text>
            </View>
            {item.unread > 0 ? <Badge count={item.unread} /> : null}
          </Pressable>
        )}
      />
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    headerTitle: { fontSize: 16, fontWeight: '700', color: colors.fg },
    searchWrap: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
    list: { paddingBottom: spacing['2xl'] },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    iconWrap: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: colors.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rowText: { flex: 1, gap: 4 },
    rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    name: { fontSize: 15, fontWeight: '600', color: colors.fg, flex: 1 },
    time: { fontSize: 12, color: colors.muted },
    preview: { fontSize: 13, color: colors.muted },
  });
}
