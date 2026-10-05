import { useMemo, useState } from 'react';
import { ArrowLeft, ChevronRight, MessageCircle, Users } from 'lucide-react-native';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { displayNameOf } from '@taskboard/app/lib/userLabel';
import { useSession } from '@taskboard/app/store/session';
import type { MemberDTO } from '@taskboard/shared';
import { useDirectory } from '../../hooks/useDirectory';
import { useIsOrgAdmin } from '../../hooks/useIsOrgAdmin';
import { useMemberRoster } from '../../hooks/useMemberRoster';
import { useOpenDirectMessage } from '../../hooks/useOpenDirectMessage';
import { usePresence } from '../../hooks/usePresence';
import { Avatar } from '../../components/Avatar';
import { Chip } from '../../components/Chip';
import { SearchInput } from '../../components/SearchInput';
import { EmptyState } from '../../components/EmptyState';
import { ListEmpty } from '../../components/QueryState';
import { spacing, type ThemeColors } from '../../constants/theme';
import type { AppTabParamList, MoreStackParamList } from '../../navigation/types';
import { useThemeColors } from '../../theme/ThemeProvider';
import { Pill, roleLabel, statusLabel, statusTone } from './member/memberUi';

type Props = NativeStackScreenProps<MoreStackParamList, 'Members'>;
type Filter = 'all' | 'active' | 'admins' | 'suspended' | 'removed';

// Only filters the roster's real fields can answer: `status` and `roles`.
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'admins', label: 'Admins' },
  { key: 'suspended', label: 'Suspended' },
  { key: 'removed', label: 'Removed' },
];

function matchMember(m: MemberDTO, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return m.displayName.toLowerCase().includes(q) || m.username.toLowerCase().includes(q) || m.email.toLowerCase().includes(q);
}

function passesFilter(m: MemberDTO, f: Filter): boolean {
  switch (f) {
    case 'active': return m.status === 'active';
    case 'admins': return m.roles.includes('org_admin');
    case 'suspended': return m.status === 'suspended';
    case 'removed': return m.status === 'removed';
    default: return true;
  }
}

/**
 * Admins get the full roster (status, email, live online/idle/offline) and can
 * open Member Details; everyone else keeps the plain directory — active people
 * only, message shortcut, no drill-in. Which list renders is a UI convenience;
 * the roster endpoints refuse non-admins server-side regardless.
 */
export function MembersScreen({ navigation }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const isAdmin = useIsOrgAdmin();
  const [query, setQuery] = useState('');

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
          <ArrowLeft size={22} color={colors.fg} />
        </Pressable>
        <Text style={styles.headerTitle}>Members</Text>
        <View style={{ width: 22 }} />
      </View>

      <View style={styles.searchWrap}>
        <SearchInput value={query} onChangeText={setQuery} placeholder="Search members..." />
      </View>

      {isAdmin ? <AdminMemberList query={query} navigation={navigation} /> : <DirectoryList query={query} navigation={navigation} />}
    </View>
  );
}

type ListProps = { query: string; navigation: Props['navigation'] };

function useMessageAction(navigation: Props['navigation'], peers: { id: string; displayName: string; username: string }[]) {
  return useOpenDirectMessage((conversationId, peerId) => {
    const peer = peers.find((u) => u.id === peerId);
    const peerName = peer ? displayNameOf({ peerDisplayName: peer.displayName, peerUsername: peer.username }) : '';
    navigation
      .getParent<BottomTabNavigationProp<AppTabParamList>>()
      ?.navigate('Chats', { screen: 'ChatConversation', params: { conversationId, peerId, peerName } });
  });
}

function DirectoryList({ query, navigation }: ListProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { filtered, isLoading } = useDirectory(query);
  const online = usePresence(filtered.map((u) => u.id));
  const { open } = useMessageAction(navigation, filtered);

  return (
    <FlatList
      data={filtered}
      keyExtractor={(u) => u.id}
      contentContainerStyle={styles.list}
      ListEmptyComponent={!isLoading ? <EmptyState icon={Users} title="No members found" /> : undefined}
      renderItem={({ item }) => (
        <View style={styles.row}>
          <Avatar name={item.displayName} src={item.avatarUrl} online={online.has(item.id)} />
          <View style={styles.rowText}>
            <Text style={styles.name} numberOfLines={1}>
              {displayNameOf({ peerDisplayName: item.displayName, peerUsername: item.username })}
            </Text>
            <Text style={styles.role}>{item.roles.includes('org_admin') ? 'Admin' : 'Member'}</Text>
          </View>
          <Pressable onPress={() => void open(item.id)} hitSlop={8} style={styles.messageButton}>
            <MessageCircle size={18} color={colors.accent} />
          </Pressable>
        </View>
      )}
    />
  );
}

function AdminMemberList({ query, navigation }: ListProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const meId = useSession((s) => s.user?.id);
  const [filter, setFilter] = useState<Filter>('all');
  const { members, activityById } = useMemberRoster(true);
  const { open } = useMessageAction(navigation, members.data ?? []);

  const rows = useMemo(
    () => (members.data ?? []).filter((m) => passesFilter(m, filter) && matchMember(m, query)),
    [members.data, filter, query],
  );

  return (
    <>
      {/* The chip row is the only thing on this screen that scrolls sideways. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipScroll}
        contentContainerStyle={styles.chipRow}
      >
        {FILTERS.map((f) => (
          <Chip key={f.key} label={f.label} active={filter === f.key} onPress={() => setFilter(f.key)} />
        ))}
      </ScrollView>

      <FlatList
        data={rows}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <ListEmpty
            isLoading={members.isLoading}
            isError={members.isError}
            error={members.error}
            onRetry={() => void members.refetch()}
            errorTitle="Couldn't load members"
            loadingLabel="Loading members..."
            empty={<EmptyState icon={Users} title="No members found" />}
          />
        }
        renderItem={({ item }) => {
          const live = activityById.get(item.id)?.state;
          const isSelf = item.id === meId;
          return (
            <Pressable
              onPress={() => navigation.navigate('MemberDetail', { userId: item.id })}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel={`Open ${item.displayName}`}
            >
              {/* `online` only for active members that telemetry reports on: a
                  suspended/removed person has no meaningful presence dot. */}
              <Avatar
                name={item.displayName}
                src={item.avatarUrl}
                online={item.status === 'active' && live ? live === 'online' : undefined}
              />
              <View style={styles.rowText}>
                <View style={styles.nameLine}>
                  <Text style={styles.name} numberOfLines={1}>
                    {item.displayName}
                    {isSelf ? ' (you)' : ''}
                  </Text>
                </View>
                <Text style={styles.role} numberOfLines={1}>
                  {item.email}
                </Text>
                <View style={styles.pills}>
                  <Pill label={roleLabel(item.roles)} tone={item.roles.includes('org_admin') ? 'accent' : 'neutral'} />
                  <Pill label={statusLabel(item.status)} tone={statusTone(item.status)} />
                  {item.status === 'active' && live ? (
                    <Pill label={live === 'online' ? 'Online' : live === 'idle' ? 'Idle' : 'Offline'} tone={live === 'online' ? 'success' : 'neutral'} />
                  ) : null}
                </View>
              </View>
              {item.status === 'active' && !isSelf ? (
                <Pressable onPress={() => void open(item.id)} hitSlop={8} style={styles.messageButton}>
                  <MessageCircle size={18} color={colors.accent} />
                </Pressable>
              ) : null}
              <ChevronRight size={18} color={colors.muted} />
            </Pressable>
          );
        }}
      />
    </>
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
    chipScroll: { flexGrow: 0 },
    chipRow: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: spacing.sm },
    list: { paddingBottom: spacing['2xl'] },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    pressed: { backgroundColor: colors.surface2 },
    rowText: { flex: 1, minWidth: 0, gap: 2 },
    nameLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    name: { fontSize: 15, fontWeight: '600', color: colors.fg, flexShrink: 1 },
    role: { fontSize: 12, color: colors.muted },
    pills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: 2 },
    messageButton: { padding: spacing.xs },
  });
}
