import { useMemo, useState } from 'react';
import { Users } from 'lucide-react-native';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useDirectory } from '../hooks/useDirectory';
import { usePresence } from '../hooks/usePresence';
import { useCreateTask } from '../hooks/useTasks';
import { Avatar } from '../components/Avatar';
import { Button } from '../components/Button';
import { Checkbox } from '../components/Checkbox';
import { EmptyState } from '../components/EmptyState';
import { ListEmpty, friendlyError } from '../components/QueryState';
import { SearchInput } from '../components/SearchInput';
import { TextField } from '../components/TextField';
import { spacing, type ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';
import { QuickDone, QuickFrame } from './QuickShell';

/**
 * Quick Task (launcher shortcut "Tasks"): title, description, members, then
 * "Create & Assign Task" -> `api.createTask({ title, description, assigneeIds })`
 * through the same `useCreateTask` hook the normal Assign Task screen uses. The
 * backend accepts several assignees, so several members can be ticked. A task
 * is reported created only after the API answers; the form keeps its content on
 * failure. The server enforces who may assign to whom.
 */
export function QuickTaskScreen({ onDone }: { onDone: () => void }) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const create = useCreateTask();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ count: number } | null>(null);
  const { all, filtered, isLoading, isError, error: loadError, refetch } = useDirectory(query);
  const online = usePresence(filtered.map((u) => u.id));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const canSubmit = title.trim().length > 0 && description.trim().length > 0 && selected.size > 0 && !create.isPending;

  const submit = async () => {
    if (!canSubmit) return;
    setError(null);
    try {
      await create.mutateAsync({ title: title.trim(), description: description.trim(), assigneeIds: [...selected] });
      setCreated({ count: selected.size });
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  const reset = () => {
    setCreated(null);
    setTitle('');
    setDescription('');
    setSelected(new Set());
    setQuery('');
  };

  const missing = !title.trim() ? 'Add a title' : !description.trim() ? 'Add a description' : selected.size === 0 ? 'Select at least one member' : null;

  return (
    <QuickFrame title="Quick Task" onBack={onDone}>
      <FlatList
        data={filtered}
        keyExtractor={(u) => u.id}
        keyboardShouldPersistTaps="handled"
        style={styles.list}
        ListHeaderComponent={
          <View style={styles.form}>
            <TextField label="Title *" value={title} onChangeText={setTitle} placeholder="What needs doing?" maxLength={200} />
            <TextField label="Description *" value={description} onChangeText={setDescription} placeholder="Add details…" multiline numberOfLines={4} style={styles.description} />
            <Text style={styles.label}>
              Assign to *{selected.size ? `  ·  ${selected.size} selected` : ''}
            </Text>
            <SearchInput value={query} onChangeText={setQuery} placeholder="Search member..." />
          </View>
        }
        ListEmptyComponent={
          <ListEmpty
            isLoading={isLoading}
            isError={isError && all.length === 0}
            error={loadError}
            onRetry={() => void refetch()}
            errorTitle="Unable to load members"
            loadingLabel="Loading members..."
            empty={<EmptyState icon={Users} title={all.length === 0 ? 'No other members in this workspace' : 'No matches'} />}
          />
        }
        renderItem={({ item }) => (
          <Pressable onPress={() => toggle(item.id)} style={styles.row} accessibilityRole="checkbox" accessibilityState={{ checked: selected.has(item.id) }}>
            <Checkbox checked={selected.has(item.id)} onPress={() => toggle(item.id)} />
            <Avatar name={item.displayName} src={item.avatarUrl} size={36} online={online.has(item.id)} />
            <Text style={styles.name} numberOfLines={1}>
              {item.displayName}
            </Text>
          </Pressable>
        )}
      />
      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : missing ? (
          <Text style={styles.hint}>{missing}</Text>
        ) : null}
        <Button title="Create & Assign Task" onPress={() => void submit()} disabled={!canSubmit} loading={create.isPending} />
      </View>
      <QuickDone
        visible={created !== null}
        message={created ? `Task created and assigned to ${created.count} ${created.count === 1 ? 'member' : 'members'}` : ''}
        anotherLabel="New task"
        onDone={onDone}
        onAnother={reset}
      />
    </QuickFrame>
  );
}


function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    list: { flex: 1 },
    form: { paddingHorizontal: spacing.lg, gap: spacing.md, paddingBottom: spacing.sm },
    description: { minHeight: 96, textAlignVertical: 'top' },
    label: { fontSize: 13, fontWeight: '600', color: colors.muted },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
    name: { flex: 1, fontSize: 15, fontWeight: '600', color: colors.fg },
    footer: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, gap: spacing.xs, backgroundColor: colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    hint: { fontSize: 12, color: colors.muted, textAlign: 'center' },
    error: { fontSize: 13, color: colors.danger, textAlign: 'center' },
  });
}
