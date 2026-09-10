import { useMemo, useState } from 'react';
import { ArrowLeft, MessageCircle, Users } from 'lucide-react-native';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { displayNameOf } from '@taskboard/app/lib/userLabel';
import { useDirectory } from '../../hooks/useDirectory';
import { useOpenDirectMessage } from '../../hooks/useOpenDirectMessage';
import { usePresence } from '../../hooks/usePresence';
import { Avatar } from '../../components/Avatar';
import { SearchInput } from '../../components/SearchInput';
import { EmptyState } from '../../components/EmptyState';
import { spacing, type ThemeColors } from '../../constants/theme';
import type { AppTabParamList, MoreStackParamList } from '../../navigation/types';
import { useThemeColors } from '../../theme/ThemeProvider';

type Props = NativeStackScreenProps<MoreStackParamList, 'Members'>;

export function MembersScreen({ navigation }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const { filtered, isLoading } = useDirectory(query);
  const online = usePresence(filtered.map((u) => u.id));
  const { open } = useOpenDirectMessage((conversationId, peerId) => {
    const peer = filtered.find((u) => u.id === peerId);
    const peerName = peer ? displayNameOf({ peerDisplayName: peer.displayName, peerUsername: peer.username }) : '';
    navigation
      .getParent<BottomTabNavigationProp<AppTabParamList>>()
      ?.navigate('Chats', { screen: 'ChatConversation', params: { conversationId, peerId, peerName } });
  });

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

      <FlatList
        data={filtered}
        keyExtractor={(u) => u.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={!isLoading ? <EmptyState icon={Users} title="No members found" /> : null}
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
      paddingVertical: spacing.sm,
    },
    rowText: { flex: 1, gap: 2 },
    name: { fontSize: 15, fontWeight: '600', color: colors.fg },
    role: { fontSize: 12, color: colors.muted },
    messageButton: { padding: spacing.xs },
  });
}
