import { useMemo, useState } from 'react';
import { Bell, LayoutGrid, MessageCircle, MoreVertical, Plus } from 'lucide-react-native';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import type { ConversationDTO } from '@taskboard/shared';
import { displayNameOf, useUserLabels } from '@taskboard/app/lib/userLabel';
import { useConversations } from '../../hooks/useConversations';
import { useNotifications } from '../../hooks/useNotifications';
import { usePresence } from '../../hooks/usePresence';
import { Avatar } from '../../components/Avatar';
import { Logo } from '../../components/Logo';
import { SearchInput } from '../../components/SearchInput';
import { EmptyState } from '../../components/EmptyState';
import { Badge } from '../../components/Badge';
import { timeAgo } from '../../lib/timeAgo';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';
import type { AppTabParamList, ChatsStackParamList } from '../../navigation/types';
import { ChatRowMenu } from './ChatRowMenu';
import { NotificationsSheet } from './NotificationsSheet';

type Props = NativeStackScreenProps<ChatsStackParamList, 'ChatsList'>;

type Tab = 'all' | 'unread' | 'mentions';

/**
 * Chats tab root — also the app's landing screen now that Home is gone (see
 * AppTabs.tsx): search, All/Unread/Mentions tabs, chat rows. "Mentions" has
 * no dedicated server concept today (there is no @-mention feature on DMs),
 * so it's a best-effort client filter over `lastMessage` text containing
 * "@" — not a fabricated backend capability.
 *
 * The header carries two icons that used to live on the removed Home
 * screen: a Workspace grid (Mail/Channels/Members/Org — see
 * more/WorkspaceScreen.tsx, reached via a cross-tab jump into More) and the
 * notification bell (NotificationsSheet, moved here verbatim).
 */
export function ChatsListScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { data: conversations = [], isLoading, isRefetching, refetch } = useConversations();
  const { data: notifications } = useNotifications();
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<Tab>('all');
  const [menuFor, setMenuFor] = useState<ConversationDTO | null>(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  const notificationsUnread = notifications?.filter((n) => !n.read).length ?? 0;

  const peerIds = useMemo(() => conversations.map((c) => c.peerId), [conversations]);
  const { avatarUrlOf } = useUserLabels(peerIds);
  const online = usePresence(peerIds);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return conversations
      .filter((c) => {
        if (tab === 'unread' && c.unread === 0) return false;
        if (tab === 'mentions' && !c.lastMessage?.includes('@')) return false;
        if (!q) return true;
        return displayNameOf(c).toLowerCase().includes(q) || (c.lastMessage ?? '').toLowerCase().includes(q);
      })
      .sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
  }, [conversations, tab, query]);

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <View style={styles.brand}>
          <Logo size={22} />
          <Text style={styles.headerTitle}>Chats</Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable
            onPress={() => navigation.getParent<BottomTabNavigationProp<AppTabParamList>>()?.navigate('More', { screen: 'Workspace' })}
            hitSlop={8}
          >
            <LayoutGrid size={22} color={colors.fg} />
          </Pressable>
          <Pressable onPress={() => setNotificationsOpen(true)} hitSlop={8} style={styles.bell}>
            <Bell size={22} color={colors.fg} />
            {notificationsUnread > 0 ? (
              <View style={styles.bellBadge}>
                <Badge count={notificationsUnread} />
              </View>
            ) : null}
          </Pressable>
          <Pressable onPress={() => navigation.navigate('NewChat')} style={styles.addButton} hitSlop={8}>
            <Plus size={20} color={colors.accentFg} />
          </Pressable>
        </View>
      </View>

      <View style={styles.searchWrap}>
        <SearchInput value={query} onChangeText={setQuery} placeholder="Search chats..." />
      </View>

      <View style={styles.tabs}>
        {(['all', 'unread', 'mentions'] as Tab[]).map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={styles.tab}>
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
              {t === 'all' ? 'All' : t === 'unread' ? 'Unread' : 'Mentions'}
            </Text>
            {tab === t ? <View style={styles.tabUnderline} /> : null}
          </Pressable>
        ))}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(c) => c.id}
        refreshing={isRefetching}
        onRefresh={() => void refetch()}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          !isLoading ? (
            <EmptyState icon={MessageCircle} title="No chats yet" subtitle="Start a new conversation with the + button." />
          ) : null
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() =>
              navigation.navigate('ChatConversation', {
                conversationId: item.id,
                peerId: item.peerId,
                peerName: displayNameOf(item),
              })
            }
            style={styles.row}
          >
            <Avatar name={displayNameOf(item)} src={avatarUrlOf(item.peerId)} online={online.has(item.peerId)} />
            <View style={styles.rowText}>
              <View style={styles.rowTop}>
                <Text style={styles.name} numberOfLines={1}>
                  {displayNameOf(item)}
                </Text>
                {item.lastMessageAt ? <Text style={styles.time}>{timeAgo(item.lastMessageAt)}</Text> : null}
              </View>
              <View style={styles.rowBottom}>
                <Text style={styles.preview} numberOfLines={1}>
                  {item.cleared ? '' : item.lastMessage ?? 'No messages yet'}
                </Text>
                {item.unread > 0 ? <Badge count={item.unread} /> : null}
              </View>
            </View>
            <Pressable onPress={() => setMenuFor(item)} hitSlop={8} style={styles.menuButton}>
              <MoreVertical size={18} color={colors.muted} />
            </Pressable>
          </Pressable>
        )}
      />

      {menuFor ? (
        <ChatRowMenu
          visible
          onClose={() => setMenuFor(null)}
          conversationId={menuFor.id}
          peerId={menuFor.peerId}
          blockedByMe={menuFor.blockedByMe}
        />
      ) : null}

      <NotificationsSheet visible={notificationsOpen} onClose={() => setNotificationsOpen(false)} />
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
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  headerTitle: { fontSize: 22, fontWeight: '700', color: colors.fg },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  bell: { position: 'relative' },
  bellBadge: { position: 'absolute', top: -4, right: -6 },
  addButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchWrap: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  tabs: {
    flexDirection: 'row',
    paddingHorizontal: spacing.lg,
    gap: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tab: { paddingBottom: spacing.sm },
  tabText: { fontSize: 14, fontWeight: '600', color: colors.muted },
  tabTextActive: { color: colors.accent },
  tabUnderline: { height: 2, backgroundColor: colors.accent, borderRadius: radius.pill, marginTop: spacing.xs },
  list: { paddingBottom: spacing['2xl'] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  rowText: { flex: 1, gap: 4 },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  name: { fontSize: 15, fontWeight: '600', color: colors.fg, flex: 1 },
  time: { fontSize: 12, color: colors.muted },
  preview: { fontSize: 13, color: colors.muted, flex: 1 },
  menuButton: { padding: spacing.xs },
  });
}
