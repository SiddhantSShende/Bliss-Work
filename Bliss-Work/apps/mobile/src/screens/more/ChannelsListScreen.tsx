import { useMemo, useState } from 'react';
import { ArrowLeft, Hash, Lock, Plus } from 'lucide-react-native';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { ChannelDTO } from '@taskboard/shared';
import { useChannels, useOpenChannels } from '../../hooks/useChannels';
import { SearchInput } from '../../components/SearchInput';
import { EmptyState } from '../../components/EmptyState';
import { Badge } from '../../components/Badge';
import { Tabs } from '../../components/Tab';
import { timeAgo } from '../../lib/timeAgo';
import { spacing, type ThemeColors } from '../../constants/theme';
import type { MoreStackParamList } from '../../navigation/types';
import { useThemeColors } from '../../theme/ThemeProvider';

type Props = NativeStackScreenProps<MoreStackParamList, 'Channels'>;
type Tab = 'mine' | 'all';

/**
 * Channels — mirrors the reference's Channels list. "My Channels" is
 * `api.channels()` (the caller's own, unread-badged, with a last-message
 * preview); "All" is that same list plus `api.openChannels()` (the org's
 * open-channel directory the caller can browse and join) — two real,
 * distinct endpoints, not a fabricated "Groups" split (this domain has no
 * separate group-channel concept — see ChannelDTO in packages/shared).
 */
export function ChannelsListScreen({ navigation }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { data: myChannels = [], isLoading: myLoading, isRefetching, refetch } = useChannels();
  const { data: openChannels = [] } = useOpenChannels();
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<Tab>('mine');

  const list = useMemo(() => {
    if (tab === 'mine') return myChannels;
    const myIds = new Set(myChannels.map((c) => c.id));
    return [...myChannels, ...openChannels.filter((c) => !myIds.has(c.id))];
  }, [tab, myChannels, openChannels]);

  const filtered = useMemo(
    () => list.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase())),
    [list, query],
  );

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
          <ArrowLeft size={22} color={colors.fg} />
        </Pressable>
        <Text style={styles.headerTitle}>Channels</Text>
        <Pressable onPress={() => navigation.navigate('CreateChannel', undefined)} style={styles.addButton} hitSlop={8}>
          <Plus size={20} color={colors.accentFg} />
        </Pressable>
      </View>

      <View style={styles.searchWrap}>
        <SearchInput value={query} onChangeText={setQuery} placeholder="Search channels..." />
      </View>

      <View style={styles.tabsWrap}>
        <Tabs
          tabs={[
            { key: 'mine', label: 'My Channels' },
            { key: 'all', label: 'All' },
          ]}
          active={tab}
          onChange={setTab}
        />
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(c) => c.id}
        refreshing={isRefetching}
        onRefresh={() => void refetch()}
        contentContainerStyle={styles.list}
        ListEmptyComponent={!myLoading ? <EmptyState icon={Hash} title="No channels yet" /> : null}
        renderItem={({ item }) => <ChannelRow channel={item} colors={colors} onPress={() => navigation.navigate('ChannelDetail', { channelId: item.id, channelName: item.name })} />}
      />
    </View>
  );
}

function ChannelRow({ channel, colors, onPress }: { channel: ChannelDTO; colors: ThemeColors; onPress: () => void }) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <Pressable onPress={onPress} style={styles.row}>
      <View style={styles.iconWrap}>
        {channel.isLocked ? <Lock size={18} color={colors.accent} /> : <Hash size={18} color={colors.accent} />}
      </View>
      <View style={styles.rowText}>
        <View style={styles.rowTop}>
          <Text style={styles.name} numberOfLines={1}>
            {channel.name}
          </Text>
          {channel.lastMessageAt ? <Text style={styles.time}>{timeAgo(channel.lastMessageAt)}</Text> : null}
        </View>
        <Text style={styles.preview} numberOfLines={1}>
          {channel.lastMessageSender ? `${channel.lastMessageSender}: ` : ''}
          {channel.cleared ? '' : channel.lastMessage ?? `${channel.memberCount} members`}
        </Text>
      </View>
      {channel.unread > 0 ? <Badge count={channel.unread} /> : null}
    </Pressable>
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
    addButton: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    searchWrap: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
    tabsWrap: { paddingHorizontal: spacing.lg },
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
