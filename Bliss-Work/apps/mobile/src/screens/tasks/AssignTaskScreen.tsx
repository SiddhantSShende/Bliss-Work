import { useMemo, useState } from 'react';
import { ArrowLeft } from 'lucide-react-native';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { UserDTO } from '@taskboard/shared';
import { useDirectory } from '../../hooks/useDirectory';
import { usePresence } from '../../hooks/usePresence';
import { useCreateTask } from '../../hooks/useTasks';
import { Avatar } from '../../components/Avatar';
import { Checkbox } from '../../components/Checkbox';
import { SearchInput } from '../../components/SearchInput';
import { TextField } from '../../components/TextField';
import { Button } from '../../components/Button';
import { spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';
import type { TasksStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<TasksStackParamList, 'AssignTask'>;

/**
 * Assign Task: title, description, and an assignee picker over the org
 * directory — the mobile counterpart of web's CreateTaskDialog "People"
 * mode (its "Channel" mode isn't part of this screen). Submits through the
 * same `api.createTask` the web dialog uses; there is no priority or due
 * date field because task-svc's create-task API doesn't have one (see
 * StickyTaskDTO / ApiClient.createTask) — adding them here would be UI for
 * behavior the backend can't perform.
 */
export function AssignTaskScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { filtered, isLoading } = useDirectory(query);
  const online = usePresence(filtered.map((u) => u.id));
  const create = useCreateTask();

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = () => {
    if (!title.trim()) return Alert.alert('Give the task a title');
    if (selected.size === 0) return Alert.alert('Pick at least one assignee');
    create.mutate(
      { title: title.trim(), description: description.trim(), assigneeIds: [...selected] },
      {
        onSuccess: () => {
          Alert.alert('Task sent', `Assigned to ${selected.size} ${selected.size === 1 ? 'person' : 'people'}.`);
          navigation.goBack();
        },
        onError: () => Alert.alert('Could not create task', 'Please try again.'),
      },
    );
  };

  const renderRow = (user: UserDTO) => (
    <Pressable onPress={() => toggle(user.id)} style={styles.row}>
      <Avatar name={user.displayName} src={user.avatarUrl} size={40} online={online.has(user.id)} />
      <Text style={styles.name} numberOfLines={1}>
        {user.displayName}
      </Text>
      <Checkbox checked={selected.has(user.id)} onPress={() => toggle(user.id)} />
    </Pressable>
  );

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
          <ArrowLeft size={22} color={colors.fg} />
        </Pressable>
        <Text style={styles.headerTitle}>Assign Task</Text>
        <View style={{ width: 22 }} />
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(u) => u.id}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View style={styles.form}>
            <TextField label="Title" value={title} onChangeText={setTitle} placeholder="What needs doing?" maxLength={200} />
            <TextField
              label="Description"
              value={description}
              onChangeText={setDescription}
              placeholder="Add details…"
              multiline
              numberOfLines={4}
              style={styles.descriptionInput}
            />
            <Text style={styles.label}>Assign to{selected.size ? ` (${selected.size})` : ''}</Text>
            <SearchInput value={query} onChangeText={setQuery} placeholder="Search people..." />
          </View>
        }
        renderItem={({ item }) => renderRow(item)}
        contentContainerStyle={styles.list}
        ListEmptyComponent={isLoading ? null : <Text style={styles.emptyText}>No matches.</Text>}
      />

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
        <Button title="Send task" onPress={submit} loading={create.isPending} />
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
    headerTitle: { fontSize: 16, fontWeight: '700', color: colors.fg },
    form: { paddingHorizontal: spacing.lg, gap: spacing.md, paddingBottom: spacing.sm },
    descriptionInput: { minHeight: 90, textAlignVertical: 'top' },
    label: { fontSize: 13, fontWeight: '600', color: colors.muted },
    list: { paddingBottom: spacing['2xl'] },
    emptyText: {
      fontSize: 13,
      color: colors.muted,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    name: { flex: 1, fontSize: 15, fontWeight: '600', color: colors.fg },
    footer: {
      padding: spacing.lg,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: colors.surface,
    },
  });
}
