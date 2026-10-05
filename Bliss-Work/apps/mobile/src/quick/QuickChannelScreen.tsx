import { useMemo, useState } from 'react';
import { Hash, Lock } from 'lucide-react-native';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import type { ChannelDTO } from '@taskboard/shared';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { useSession } from '@taskboard/app/store/session';
import { useChannels } from '../hooks/useChannels';
import { qk } from '../hooks/queryKeys';
import { channelRowPreview } from '../lib/rowPreview';
import { EmptyState } from '../components/EmptyState';
import { ListEmpty, friendlyError } from '../components/QueryState';
import { SearchInput } from '../components/SearchInput';
import { radius, spacing, type ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';
import { QuickComposer, QuickDone, QuickFrame, RadioDot } from './QuickShell';

/**
 * Quick Channel (launcher shortcut "Channels"): pick one of YOUR channels (the
 * same `api.channels()` list the Channels tab shows — private channels appear
 * only if you're a member), type, send with `api.sendChannelMessage`.
 * The row's last message is shown as the "recent message" context.
 */
export function QuickChannelScreen({ onDone }: { onDone: () => void }) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { api } = useRuntime();
  const qc = useQueryClient();
  const meId = useSession((s) => s.user?.id);
  const { data: channels = [], isLoading, isError, error: loadError, refetch } = useChannels();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ChannelDTO | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return channels.filter((c) => !q || c.name.toLowerCase().includes(q));
  }, [channels, query]);

  const send = async () => {
    const body = draft.trim();
    if (!selected || !body || sending) return;
    setSending(true);
    setError(null);
    try {
      await api.sendChannelMessage(selected.id, body);
      void qc.invalidateQueries({ queryKey: qk.channels });
      void qc.invalidateQueries({ queryKey: qk.channelMessages(selected.id) });
      setSentTo(selected.name);
    } catch (e) {
      setError(friendlyError(e));
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
    <QuickFrame title="Quick Channel" onBack={onDone}>
      <View style={styles.searchWrap}>
        <SearchInput value={query} onChangeText={setQuery} placeholder="Search channels..." />
      </View>
      <Text style={styles.section}>Workspace Channels</Text>
      <FlatList
        data={filtered}
        keyExtractor={(c) => c.id}
        keyboardShouldPersistTaps="handled"
        style={styles.list}
        ListEmptyComponent={
          <ListEmpty
            isLoading={isLoading}
            isError={isError && channels.length === 0}
            error={loadError}
            onRetry={() => void refetch()}
            errorTitle="Unable to load channels"
            loadingLabel="Loading channels..."
            empty={<EmptyState icon={Hash} title={channels.length === 0 ? "You're not in any channels yet" : 'No matches'} />}
          />
        }
        renderItem={({ item }) => {
          const on = selected?.id === item.id;
          return (
            <Pressable onPress={() => setSelected(on ? null : item)} style={[styles.row, on && styles.rowOn]} accessibilityRole="radio" accessibilityState={{ selected: on }}>
              <View style={styles.icon}>{item.isLocked ? <Lock size={18} color={colors.accent} /> : <Hash size={18} color={colors.accent} />}</View>
              <View style={styles.rowText}>
                <Text style={styles.name} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={styles.sub} numberOfLines={1}>
                  {channelRowPreview(item, meId)}
                </Text>
              </View>
              <RadioDot selected={on} />
            </Pressable>
          );
        }}
      />
      <QuickComposer
        chipLabel={selected?.name ?? null}
        chipPrefix="# "
        onClearChip={() => setSelected(null)}
        value={draft}
        onChangeText={setDraft}
        onSend={() => void send()}
        sending={sending}
        error={error}
        placeholder="Type a message..."
        emptyPlaceholder="Pick a channel first"
      />
      <QuickDone visible={sentTo !== null} message={`Message sent to #${sentTo ?? ''}`} anotherLabel="Send another" onDone={onDone} onAnother={reset} />
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
    icon: { width: 40, height: 40, borderRadius: radius.pill, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
    rowText: { flex: 1, gap: 1 },
    name: { fontSize: 15, fontWeight: '600', color: colors.fg },
    sub: { fontSize: 12, color: colors.muted },
  });
}
