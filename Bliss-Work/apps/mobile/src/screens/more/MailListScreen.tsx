import { useMemo } from 'react';
import { ArrowLeft, Mail as MailIcon } from 'lucide-react-native';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useMailInbox } from '../../hooks/useMailInbox';
import { EmptyState } from '../../components/EmptyState';
import { Badge } from '../../components/Badge';
import { timeAgo } from '../../lib/timeAgo';
import { spacing, type ThemeColors } from '../../constants/theme';
import type { MoreStackParamList } from '../../navigation/types';
import { useThemeColors } from '../../theme/ThemeProvider';

type Props = NativeStackScreenProps<MoreStackParamList, 'Mail'>;

/** Read-first Mail list (lighter tier than Chats/Tasks/Meetings, per the
 *  redesign plan) — real `api.inbox(..., ['MAIL'])` rows, tap through to the
 *  full message. No compose/reply in this pass. */
export function MailListScreen({ navigation }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { data, isLoading, isRefetching, refetch } = useMailInbox();
  const items = data?.items ?? [];

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
          <ArrowLeft size={22} color={colors.fg} />
        </Pressable>
        <Text style={styles.headerTitle}>Mail</Text>
        <View style={{ width: 22 }} />
      </View>

      <FlatList
        data={items}
        keyExtractor={(it) => it.refId}
        refreshing={isRefetching}
        onRefresh={() => void refetch()}
        contentContainerStyle={styles.list}
        ListEmptyComponent={!isLoading ? <EmptyState icon={MailIcon} title="No mail" /> : null}
        renderItem={({ item }) => (
          <Pressable onPress={() => navigation.navigate('MailDetail', { mailId: item.refId })} style={styles.row}>
            <View style={[styles.dot, item.unreadCount > 0 && styles.dotUnread]} />
            <View style={styles.rowText}>
              <View style={styles.rowTop}>
                <Text style={[styles.sender, item.unreadCount > 0 && styles.bold]} numberOfLines={1}>
                  {item.peerUsername ?? 'Unknown sender'}
                </Text>
                <Text style={styles.time}>{timeAgo(item.lastEventAt)}</Text>
              </View>
              <Text style={styles.preview} numberOfLines={1}>
                {item.preview}
              </Text>
            </View>
            {item.unreadCount > 0 ? <Badge count={item.unreadCount} /> : null}
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
    list: { paddingBottom: spacing['2xl'] },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: 'transparent' },
    dotUnread: { backgroundColor: colors.accent },
    rowText: { flex: 1, gap: 2 },
    rowTop: { flexDirection: 'row', justifyContent: 'space-between' },
    sender: { fontSize: 14, color: colors.fg, flex: 1 },
    bold: { fontWeight: '700' },
    time: { fontSize: 12, color: colors.muted },
    preview: { fontSize: 13, color: colors.muted },
  });
}
