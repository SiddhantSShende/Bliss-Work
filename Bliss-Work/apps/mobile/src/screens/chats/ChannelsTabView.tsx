import { useMemo, useState } from 'react';
import { ArrowLeft, Hash, Lock, MoreVertical, Pin, Plus } from 'lucide-react-native';
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { ChannelDTO } from '@taskboard/shared';
import { useSession } from '@taskboard/app/store/session';
import { useChannels, useOpenChannels } from '../../hooks/useChannels';
import { usePinnedThreads } from '../../lib/pinnedThreads';
import { ListEmpty } from '../../components/QueryState';
import { EmptyState } from '../../components/EmptyState';
import { Badge } from '../../components/Badge';
import { Tabs } from '../../components/Tab';
import { channelRowPreview } from '../../lib/rowPreview';
import { timeAgo } from '../../lib/timeAgo';
import { spacing, type ThemeColors } from '../../constants/theme';
import type { MoreStackParamList } from '../../navigation/types';
import { useThemeColors } from '../../theme/ThemeProvider';
import { ChannelListRowMenu } from './ChannelListRowMenu';

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
export function ChannelsTabView({ navigation, query = '' }: { navigation: any; query?: string }) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { data: myChannels = [], isLoading: myLoading, isError, error, isRefetching, refetch } = useChannels();
  const { data: openChannels = [] } = useOpenChannels();
  const [tab, setTab] = useState<Tab>('mine');
  const [menuFor, setMenuFor] = useState<ChannelDTO | null>(null);
  const meId = useSession((s) => s.user?.id);
  const { isChannelPinned, pinnedChannelIds } = usePinnedThreads();

  const myIds = useMemo(() => new Set(myChannels.map((c) => c.id)), [myChannels]);

  const list = useMemo(() => {
    if (tab === 'mine') return myChannels;
    const myIds = new Set(myChannels.map((c) => c.id));
    return [...myChannels, ...openChannels.filter((c) => !myIds.has(c.id))];
  }, [tab, myChannels, openChannels]);

  const filtered = useMemo(
    () => list.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase())),
    [list, query],
  );

  // Pin only makes sense for a channel you're actually in — the "All" tab also
  // lists open-but-unjoined channels, so the pinned/rest split (and the
  // 3-dot menu itself) only ever applies on "My Channels".
  const sections = useMemo(() => {
    if (tab !== 'mine' || pinnedChannelIds.length === 0) return [{ title: null, data: filtered }];
    const byId = new Map(filtered.map((c) => [c.id, c]));
    const pinned = pinnedChannelIds.map((id) => byId.get(id)).filter((c): c is ChannelDTO => !!c);
    const rest = filtered.filter((c) => !isChannelPinned(c.id));
    const out: { title: string | null; data: ChannelDTO[] }[] = [];
    if (pinned.length > 0) out.push({ title: 'Pinned', data: pinned });
    if (rest.length > 0) out.push({ title: pinned.length > 0 ? 'All Channels' : null, data: rest });
    return out;
  }, [tab, filtered, pinnedChannelIds, isChannelPinned]);

  return (
    <View style={styles.flex}>
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

      <SectionList
        sections={sections}
        keyExtractor={(c) => c.id}
        refreshing={isRefetching}
        onRefresh={() => void refetch()}
        contentContainerStyle={styles.list}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) =>
          section.title ? (
            <View style={styles.sectionHeader}>
              {section.title === 'Pinned' ? <Pin size={12} color={colors.muted} /> : null}
              <Text style={styles.sectionTitle}>{section.title}</Text>
            </View>
          ) : null
        }
        ListEmptyComponent={
          <ListEmpty
            isLoading={myLoading}
            isError={isError}
            error={error}
            onRetry={() => void refetch()}
            errorTitle="Unable to load channels"
            loadingLabel="Loading channels..."
            empty={<EmptyState icon={Hash} title={query.trim() ? 'No matching channels' : 'No channels yet'} />}
          />
        }
        renderItem={({ item }) => {
          const mine = myIds.has(item.id);
          return (
            <ChannelRow
              channel={item}
              colors={colors}
              meId={meId}
              pinned={mine && isChannelPinned(item.id)}
              onMenu={mine ? () => setMenuFor(item) : undefined}
              onPress={() =>
                // Members open the conversation; an open channel you haven't joined opens its
                // detail page (which has the Join button) — messages need membership.
                navigation.navigate(mine ? 'ChannelConversation' : 'ChannelDetail', { channelId: item.id, channelName: item.name })
              }
            />
          );
        }}
      />

      {menuFor ? <ChannelListRowMenu visible onClose={() => setMenuFor(null)} channelId={menuFor.id} /> : null}
    </View>
  );
}


function ChannelRow({
  channel,
  colors,
  meId,
  pinned,
  onMenu,
  onPress,
}: {
  channel: ChannelDTO;
  colors: ThemeColors;
  meId: string | undefined;
  pinned: boolean;
  onMenu?: () => void;
  onPress: () => void;
}) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <Pressable onPress={onPress} style={styles.row}>
      <View style={styles.iconWrap}>
        {channel.isLocked ? <Lock size={18} color={colors.accent} /> : <Hash size={18} color={colors.accent} />}
      </View>
      <View style={styles.rowText}>
        <View style={styles.rowTop}>
          {pinned ? <Pin size={12} color={colors.muted} /> : null}
          <Text style={styles.name} numberOfLines={1}>
            {channel.name}
          </Text>
          {channel.lastMessageAt ? <Text style={styles.time}>{timeAgo(channel.lastMessageAt)}</Text> : null}
        </View>
        <Text style={styles.preview} numberOfLines={1}>
          {channelRowPreview(channel, meId)}
        </Text>
      </View>
      {channel.unread > 0 ? <Badge count={channel.unread} /> : null}
      {onMenu ? (
        <Pressable onPress={onMenu} hitSlop={8} style={styles.menuButton}>
          <MoreVertical size={18} color={colors.muted} />
        </Pressable>
      ) : null}
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
    rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.xs },
    name: { fontSize: 15, fontWeight: '600', color: colors.fg, flex: 1 },
    time: { fontSize: 12, color: colors.muted },
    preview: { fontSize: 13, color: colors.muted },
    menuButton: { padding: spacing.xs },
    sectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      paddingBottom: spacing.xs,
      backgroundColor: colors.bg,
    },
    sectionTitle: {
      fontSize: 12,
      fontWeight: '700',
      color: colors.muted,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
    },
  });
}
