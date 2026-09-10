import { useMemo, useState } from 'react';
import { CheckSquare } from 'lucide-react-native';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { StickyTaskDTO } from '@taskboard/shared';
import { useTasks } from '../../hooks/useTasks';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import type { TasksStackParamList } from '../../navigation/types';
import { useThemeColors } from '../../theme/ThemeProvider';

type Props = NativeStackScreenProps<TasksStackParamList, 'TasksList'>;

type Bucket = 'mine' | 'available' | 'completed';
const BUCKETS: { key: Bucket; label: string }[] = [
  { key: 'available', label: 'Available' },
  { key: 'mine', label: 'In progress' },
  { key: 'completed', label: 'Completed' },
];

function bucketOf(status: StickyTaskDTO['myStatus']): Bucket | null {
  if (status === 'SENT') return 'available';
  if (status === 'ACKNOWLEDGED') return 'mine';
  if (status === 'COMPLETED') return 'completed';
  return null; // IGNORED/LEFT — not shown in any bucket, same as web's Tasks.tsx
}

/** Tasks tab: buckets (Available/In progress/Completed) over my assignments,
 *  card-per-task, tap through to accept/complete/ignore. */
export function TasksListScreen({ navigation }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { assigned } = useTasks();
  const [bucket, setBucket] = useState<Bucket>('available');

  const tasks = useMemo(
    () => (assigned.data ?? []).filter((t) => bucketOf(t.myStatus) === bucket),
    [assigned.data, bucket],
  );

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <Text style={styles.header}>Tasks</Text>

      <View style={styles.tabs}>
        {BUCKETS.map((b) => (
          <Pressable key={b.key} onPress={() => setBucket(b.key)} style={styles.tab}>
            <Text style={[styles.tabText, bucket === b.key && styles.tabTextActive]}>{b.label}</Text>
            {bucket === b.key ? <View style={styles.tabUnderline} /> : null}
          </Pressable>
        ))}
      </View>

      <FlatList
        data={tasks}
        keyExtractor={(t) => t.taskId}
        contentContainerStyle={styles.list}
        refreshing={assigned.isRefetching}
        onRefresh={() => void assigned.refetch()}
        ListEmptyComponent={
          <EmptyState icon={CheckSquare} title="Nothing here" subtitle="Tasks in this bucket will show up here." />
        }
        renderItem={({ item }) => (
          <Pressable onPress={() => navigation.navigate('TaskDetail', { taskId: item.taskId })}>
            <Card style={styles.card}>
              <Text style={styles.title} numberOfLines={2}>
                {item.title}
              </Text>
              <Text style={styles.sender} numberOfLines={1}>
                From {item.senderDisplayName || item.senderUsername}
              </Text>
            </Card>
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
      fontSize: 22,
      fontWeight: '700',
      color: colors.fg,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      paddingBottom: spacing.md,
    },
    tabs: {
      flexDirection: 'row',
      paddingHorizontal: spacing.lg,
      gap: spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    tab: {
      paddingBottom: spacing.sm,
    },
    tabText: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.muted,
    },
    tabTextActive: {
      color: colors.accent,
    },
    tabUnderline: {
      height: 2,
      backgroundColor: colors.accent,
      borderRadius: radius.pill,
      marginTop: spacing.xs,
    },
    list: {
      padding: spacing.lg,
      gap: spacing.sm,
    },
    card: {
      gap: 4,
    },
    title: {
      fontSize: 15,
      fontWeight: '600',
      color: colors.fg,
    },
    sender: {
      fontSize: 12,
      color: colors.muted,
    },
  });
}
