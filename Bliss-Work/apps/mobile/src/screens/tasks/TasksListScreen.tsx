import { useMemo, useState } from 'react';
import { CheckSquare, ChevronRight, Plus } from 'lucide-react-native';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { AssigneeStatus, SentTaskDTO, StickyTaskDTO } from '@taskboard/shared';
import { useTasks } from '../../hooks/useTasks';
import { STATUS_LABEL } from '../../lib/taskStatus';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { ListEmpty } from '../../components/QueryState';
import { Chip } from '../../components/Chip';
import { Tabs } from '../../components/Tab';
import { spacing, type ThemeColors } from '../../constants/theme';
import type { TasksStackParamList } from '../../navigation/types';
import { useThemeColors } from '../../theme/ThemeProvider';

type Props = NativeStackScreenProps<TasksStackParamList, 'TasksList'>;

type MainTab = 'mine' | 'assigned' | 'all';
type StatusFilter = 'all' | AssigneeStatus;


interface Row {
  key: string;
  title: string;
  subtitle: string;
  kind: 'sent' | 'assigned';
  assignedTask?: StickyTaskDTO;
}

function sentRow(t: SentTaskDTO): Row {
  const done = t.assignees.filter((a) => a.status === 'COMPLETED').length;
  return { key: `sent:${t.taskId}`, title: t.title, subtitle: `${done} of ${t.assignees.length} completed`, kind: 'sent' };
}

function assignedRow(t: StickyTaskDTO): Row {
  return {
    key: `assigned:${t.taskId}`,
    title: t.title,
    subtitle: `From ${t.senderDisplayName || t.senderUsername} · ${STATUS_LABEL[t.myStatus]}`,
    kind: 'assigned',
    assignedTask: t,
  };
}

/**
 * Tasks — "My Tasks" (sent, `SentTaskDTO[]`, real per-assignee completion
 * counts) / "Assigned to Me" (`StickyTaskDTO[]`, with real status filter
 * chips) / "All" (both, merged). No Priority or Due Date anywhere: neither
 * field exists on either DTO (confirmed against packages/shared/src/types/
 * domain.ts) — showing them would mean fabricating data, so this shows what
 * the API actually has: title, sender/assignee progress, status.
 *
 * "My Tasks" rows aren't tappable — there is no sender-perspective task
 * detail endpoint (`taskDetail()` returns the CALLER's own assignee view;
 * sending a task the caller isn't also assigned to has no detail screen to
 * open today). That's a real API gap, not something to paper over with a
 * screen that would 404.
 */
export function TasksListScreen({ navigation }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { assigned, sent } = useTasks();
  const [tab, setTab] = useState<MainTab>('assigned');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const assignedRows = useMemo(
    () =>
      (assigned.data ?? [])
        .filter((t) => statusFilter === 'all' || t.myStatus === statusFilter)
        .map(assignedRow),
    [assigned.data, statusFilter],
  );
  const sentRows = useMemo(() => (sent.data ?? []).map(sentRow), [sent.data]);

  const rows = tab === 'mine' ? sentRows : tab === 'assigned' ? assignedRows : [...sentRows, ...assignedRows];
  const active = tab === 'mine' ? [sent] : tab === 'assigned' ? [assigned] : [sent, assigned];
  const isLoading = active.some((q) => q.isLoading);
  const failed = active.find((q) => q.isError);
  const isRefetching = active.some((q) => q.isRefetching && !q.isLoading);
  const refetch = () => Promise.all(active.map((q) => q.refetch()));

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Tasks</Text>
        <Pressable onPress={() => navigation.navigate('AssignTask')} style={styles.addButton} hitSlop={8}>
          <Plus size={20} color={colors.accentFg} />
        </Pressable>
      </View>

      <View style={styles.tabsWrap}>
        <Tabs
          tabs={[
            { key: 'mine', label: 'My Tasks' },
            { key: 'assigned', label: 'Assigned to Me' },
            { key: 'all', label: 'All' },
          ]}
          active={tab}
          onChange={setTab}
        />
      </View>

      {tab === 'assigned' ? (
        <View style={styles.chipsRow}>
          {(['all', 'SENT', 'ACKNOWLEDGED', 'COMPLETED'] as StatusFilter[]).map((s) => (
            <Chip
              key={s}
              label={s === 'all' ? 'All' : STATUS_LABEL[s]}
              active={statusFilter === s}
              onPress={() => setStatusFilter(s)}
            />
          ))}
        </View>
      ) : null}

      <FlatList
        data={rows}
        keyExtractor={(r) => r.key}
        contentContainerStyle={styles.list}
        refreshing={isRefetching}
        onRefresh={() => void refetch()}
        ListEmptyComponent={
          <ListEmpty
            isLoading={isLoading}
            isError={!!failed}
            error={failed?.error}
            onRetry={() => void refetch()}
            errorTitle="Unable to load tasks"
            loadingLabel="Loading tasks..."
            empty={<EmptyState icon={CheckSquare} title="Nothing here" />}
          />
        }
        renderItem={({ item }) => (
          <Pressable
            disabled={item.kind !== 'assigned'}
            onPress={() => item.assignedTask && navigation.navigate('TaskDetail', { taskId: item.assignedTask.taskId })}
          >
            <Card flat style={styles.card}>
              <View style={styles.cardText}>
                <Text style={styles.title} numberOfLines={2}>
                  {item.title}
                </Text>
                <Text style={styles.subtitle} numberOfLines={1}>
                  {item.subtitle}
                </Text>
              </View>
              {item.kind === 'assigned' ? <ChevronRight size={18} color={colors.muted} /> : null}
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
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      paddingBottom: spacing.sm,
    },
    headerTitle: { fontSize: 22, fontWeight: '700', color: colors.fg },
    addButton: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    tabsWrap: { paddingHorizontal: spacing.lg },
    chipsRow: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
    list: { padding: spacing.lg, paddingTop: spacing.sm, gap: spacing.sm },
    card: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    cardText: { flex: 1, gap: 4 },
    title: { fontSize: 15, fontWeight: '600', color: colors.fg },
    subtitle: { fontSize: 12, color: colors.muted },
  });
}

