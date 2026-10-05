import { useMemo, useState } from 'react';
import { Users } from 'lucide-react-native';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import type { UserDTO } from '@taskboard/shared';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { useDirectory } from '../hooks/useDirectory';
import { usePresence } from '../hooks/usePresence';
import { qk } from '../hooks/queryKeys';
import { Avatar } from '../components/Avatar';
import { EmptyState } from '../components/EmptyState';
import { ListEmpty, friendlyError } from '../components/QueryState';
import { SearchInput } from '../components/SearchInput';
import { spacing, type ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';
import { QuickComposer, QuickDone, QuickFrame, RadioDot } from './QuickShell';

/**
 * Quick Chat (launcher shortcut "Chats"): pick a workspace member, type, send.
 * Real APIs only — the member list is `api.directory()` (same source as Home /
 * Forward / task assignment), and Send is exactly what the normal chat does:
 * `openConversation(peer)` (find-or-create the DM) then `reply(conversationId, body)`.
 * Success is shown only after the backend confirms; a failure keeps the draft.
 */
export function QuickChatScreen({ onDone }: { onDone: () => void }) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<UserDTO | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { all, filtered, isLoading, isError, error: loadError, refetch } = useDirectory(query);
  const online = usePresence(filtered.map((u) => u.id));

  const send = async () => {
    const body = draft.trim();
    if (!selected || !body || sending) return;
    setSending(true);
    setError(null);
    try {
      const { conversationId } = await api.openConversation(selected.id);
      await api.reply(conversationId, body);
      void qc.invalidateQueries({ queryKey: qk.conversations });
      void qc.invalidateQueries({ queryKey: qk.messages(conversationId) });
      setSentTo(selected.displayName);
    } catch (e) {
      setError(friendlyError(e)); // never "sent" unless the backend said so
    } finally {
      setSending(false);
    }
  };

  const reset = () => {
    setSentTo(null);
    setDraft('');
    setSelected(null);
    setQuery('');
  };

  return (
    <QuickFrame title="Quick Chat" onBack={onDone}>
      <View style={styles.searchWrap}>
        <SearchInput value={query} onChangeText={setQuery} placeholder="Search members..." />
      </View>
      <Text style={styles.section}>Workspace Members</Text>
      <FlatList
        data={filtered}
        keyExtractor={(u) => u.id}
        keyboardShouldPersistTaps="handled"
        style={styles.list}
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
        renderItem={({ item }) => {
          const on = selected?.id === item.id;
          return (
            <Pressable onPress={() => setSelected(on ? null : item)} style={[styles.row, on && styles.rowOn]} accessibilityRole="radio" accessibilityState={{ selected: on }}>
              <Avatar name={item.displayName} src={item.avatarUrl} size={40} online={online.has(item.id)} />
              <View style={styles.rowText}>
                <Text style={styles.name} numberOfLines={1}>
                  {item.displayName}
                </Text>
                <Text style={styles.sub}>{online.has(item.id) ? 'Online' : 'Offline'}</Text>
              </View>
              <RadioDot selected={on} />
            </Pressable>
          );
        }}
      />
      <QuickComposer
        chipLabel={selected?.displayName ?? null}
        chipPrefix=""
        onClearChip={() => setSelected(null)}
        value={draft}
        onChangeText={setDraft}
        onSend={() => void send()}
        sending={sending}
        error={error}
        placeholder="Type a message..."
      />
      <QuickDone visible={sentTo !== null} message={`Message sent to ${sentTo ?? ''}`} anotherLabel="Send another" onDone={onDone} onAnother={reset} />
    </QuickFrame>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    searchWrap: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
    section: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xs, fontSize: 12, fontWeight: '700', color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.5 },
    list: { flex: 1 },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm + 2 },
    rowOn: { backgroundColor: colors.accentSoft },
    rowText: { flex: 1, gap: 1 },
    name: { fontSize: 15, fontWeight: '600', color: colors.fg },
    sub: { fontSize: 12, color: colors.muted },
  });
}
