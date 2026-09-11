import { useMemo, useState } from 'react';
import { ArrowLeft, MoreVertical } from 'lucide-react-native';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { ChannelMemberDTO } from '@taskboard/shared';
import { useSession } from '@taskboard/app/store/session';
import { useUserLabels } from '@taskboard/app/lib/userLabel';
import { Avatar } from '../../components/Avatar';
import { SearchInput } from '../../components/SearchInput';
import { Button } from '../../components/Button';
import { useChannelRoster, useKickChannelMember } from '../../hooks/useChannels';
import { spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';
import type { MoreStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<MoreStackParamList, 'ChannelMembers'>;

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

/** Real channel roster (`api.channelRoster`, role + blocked flag) — mirrors
 *  the reference's Channel Members screen. Kicking a member is offered only
 *  when the caller is themselves an owner/admin, same authorization the
 *  server re-checks regardless. */
export function ChannelMembersScreen({ route, navigation }: Props) {
  const { channelId, channelName } = route.params;
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const me = useSession((s) => s.user);
  const { data: roster, isLoading } = useChannelRoster(channelId);
  const kick = useKickChannelMember(channelId);
  const [query, setQuery] = useState('');

  const visible = (roster ?? []).filter((m) => !m.blocked);
  const userIds = useMemo(() => visible.map((m) => m.userId), [visible]);
  const { nameOf, avatarUrlOf } = useUserLabels(userIds);
  const myRole = visible.find((m) => m.userId === me?.id)?.role;
  const canManage = myRole === 'owner' || myRole === 'admin';

  const filtered = visible.filter((m) =>
    nameOf(m.userId).toLowerCase().includes(query.trim().toLowerCase()),
  );

  const confirmKick = (member: ChannelMemberDTO) => {
    Alert.alert('Remove member?', `${nameOf(member.userId)} will be removed from ${channelName}.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => kick.mutate(member.userId) },
    ]);
  };

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
          <ArrowLeft size={22} color={colors.fg} />
        </Pressable>
        <View>
          <Text style={styles.headerTitle}>{channelName}</Text>
          <Text style={styles.headerSubtitle}>{visible.length} members</Text>
        </View>
        <View style={{ width: 22 }} />
      </View>

      <View style={styles.searchWrap}>
        <SearchInput value={query} onChangeText={setQuery} placeholder="Search members..." />
      </View>

      {isLoading ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.xl }} />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(m) => m.userId}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <Avatar name={nameOf(item.userId)} src={avatarUrlOf(item.userId)} size={40} />
              <View style={styles.rowText}>
                <Text style={styles.name}>{nameOf(item.userId)}</Text>
                <Text style={styles.role}>{ROLE_LABEL[item.role] ?? item.role}</Text>
              </View>
              {canManage && item.userId !== me?.id ? (
                <Pressable onPress={() => confirmKick(item)} hitSlop={8}>
                  <MoreVertical size={18} color={colors.muted} />
                </Pressable>
              ) : null}
            </View>
          )}
        />
      )}

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
        <Button
          title="Add Members"
          onPress={() => navigation.navigate('CreateChannel', { addToChannelId: channelId, addToChannelName: channelName })}
          variant="ghost"
        />
      </View>
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
    headerTitle: { fontSize: 16, fontWeight: '700', color: colors.fg, textAlign: 'center' },
    headerSubtitle: { fontSize: 12, color: colors.muted, textAlign: 'center' },
    searchWrap: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
    list: { paddingHorizontal: spacing.lg, paddingBottom: spacing['2xl'], gap: spacing.sm },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
    rowText: { flex: 1, gap: 2 },
    name: { fontSize: 15, fontWeight: '600', color: colors.fg },
    role: { fontSize: 12, color: colors.muted },
    footer: { padding: spacing.lg, borderTopWidth: 1, borderTopColor: colors.border },
  });
}
