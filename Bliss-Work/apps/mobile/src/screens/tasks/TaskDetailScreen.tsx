import { useMemo } from 'react';
import { ArrowLeft } from 'lucide-react-native';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTaskDetail, useTaskAction } from '../../hooks/useTasks';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { spacing, type ThemeColors } from '../../constants/theme';
import type { TasksStackParamList } from '../../navigation/types';
import { useThemeColors } from '../../theme/ThemeProvider';
import { ErrorState, LoadingState } from '../../components/QueryState';

type Props = NativeStackScreenProps<TasksStackParamList, 'TaskDetail'>;

const STATUS_LABEL: Record<string, string> = {
  SENT: 'Awaiting your response',
  ACKNOWLEDGED: 'In progress',
  COMPLETED: 'Completed',
  IGNORED: 'Ignored',
  LEFT: 'Left',
  MISSED: 'Missed — the deadline passed',
};

export function TaskDetailScreen({ route, navigation }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { data: task, isLoading, isError, error, refetch } = useTaskDetail(route.params.taskId);
  const action = useTaskAction();

  const run = async (a: 'acknowledge' | 'complete' | 'ignore' | 'leave') => {
    await action.mutateAsync({ taskId: route.params.taskId, action: a });
    if (a === 'ignore') navigation.goBack();
  };

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
          <ArrowLeft size={22} color={colors.fg} />
        </Pressable>
        <Text style={styles.headerTitle}>Task</Text>
        <View style={{ width: 22 }} />
      </View>

      {isLoading ? (
        <LoadingState label="Loading task..." />
      ) : isError || !task ? (
        <ErrorState title="Unable to load this task" error={error} onRetry={() => void refetch()} />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <Card style={styles.card}>
            <Text style={styles.title}>{task.title}</Text>
            <Text style={styles.status}>{STATUS_LABEL[task.myStatus] ?? task.myStatus}</Text>
            <Text style={styles.description}>{task.description}</Text>
            <Text style={styles.sender}>From {task.senderDisplayName || task.senderUsername}</Text>
          </Card>

          <View style={styles.actions}>
            {task.myStatus === 'SENT' ? (
              <>
                <Button title="Acknowledge" onPress={() => void run('acknowledge')} loading={action.isPending} />
                <Button title="Ignore" variant="ghost" onPress={() => void run('ignore')} disabled={action.isPending} />
              </>
            ) : null}
            {task.myStatus === 'ACKNOWLEDGED' ? (
              <>
                <Button title="Mark complete" onPress={() => void run('complete')} loading={action.isPending} />
                <Button title="Leave task" variant="ghost" onPress={() => void run('leave')} disabled={action.isPending} />
              </>
            ) : null}
          </View>
        </ScrollView>
      )}
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
    spinner: { marginTop: spacing['2xl'] },
    content: { padding: spacing.lg, gap: spacing.lg },
    card: { gap: spacing.sm },
    title: { fontSize: 18, fontWeight: '700', color: colors.fg },
    status: { fontSize: 13, fontWeight: '600', color: colors.accent },
    description: { fontSize: 14, color: colors.fg, lineHeight: 20 },
    sender: { fontSize: 12, color: colors.muted },
    actions: { gap: spacing.sm },
  });
}
