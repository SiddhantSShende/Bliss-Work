import { useMemo, useState } from 'react';
import { Hash, X } from 'lucide-react-native';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { ChannelDTO } from '@taskboard/shared';
import { useChannels } from '../../hooks/useChannels';
import { Button } from '../Button';
import { Checkbox } from '../Checkbox';
import { EmptyState } from '../EmptyState';
import { Modal } from '../Modal';
import { ErrorState, LoadingState } from '../QueryState';
import { SearchInput } from '../SearchInput';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Channels already on the meeting: shown disabled, never selectable twice. */
  alreadyIds?: readonly string[];
  onConfirm: (channels: ChannelDTO[]) => void;
}

/**
 * Picker for the New Meeting form's "Channels": the channels the caller really
 * belongs to (`useChannels` -> `api.channels()`, the same source as the Channels
 * tab), with search and a checkmark per selection — the channel counterpart of
 * `MemberPickerSheet`, laid out the same way. Everyone in a chosen channel is
 * invited when the meeting is created (the form resolves the roster then).
 */
export function ChannelPickerSheet({ visible, onClose, alreadyIds = [], onConfirm }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { height } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ChannelDTO[]>([]);
  const { data, isLoading, isError, error, refetch } = useChannels();

  const all = useMemo(() => data ?? [], [data]);
  const already = useMemo(() => new Set(alreadyIds), [alreadyIds]);
  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => (q ? all.filter((c) => c.name.toLowerCase().includes(q)) : all), [all, q]);
  const isSelected = (id: string) => selected.some((c) => c.id === id);
  const toggle = (c: ChannelDTO) => {
    if (already.has(c.id)) return;
    setSelected((prev) => (prev.some((p) => p.id === c.id) ? prev.filter((p) => p.id !== c.id) : [...prev, c]));
  };

  const close = () => {
    setQuery('');
    setSelected([]);
    onClose();
  };
  const submit = () => {
    if (selected.length === 0) return;
    onConfirm(selected);
    close();
  };

  return (
    <Modal visible={visible} onClose={close} title="Add channels" scroll={false} maxHeight="85%">
      <View style={[styles.wrap, { height: Math.min(540, Math.round(height * 0.64)) }]}>
        <SearchInput value={query} onChangeText={setQuery} placeholder="Search channels..." />

        {selected.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled">
            {selected.map((c) => (
              <Pressable key={c.id} onPress={() => toggle(c)} style={styles.chip} accessibilityLabel={`Remove ${c.name}`}>
                <Text style={styles.chipText} numberOfLines={1}>
                  #{c.name}
                </Text>
                <X size={13} color={colors.accent} />
              </Pressable>
            ))}
          </ScrollView>
        ) : null}

        {isLoading ? (
          <LoadingState label="Loading channels..." />
        ) : isError && all.length === 0 ? (
          <ErrorState title="Unable to load channels" error={error} onRetry={() => void refetch()} />
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={(c) => c.id}
            style={styles.list}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={<EmptyState icon={Hash} title={all.length === 0 ? "You're not in any channels yet" : 'No matches'} />}
            renderItem={({ item }) => {
              const isIn = already.has(item.id);
              return (
                <Pressable
                  style={[styles.row, isIn && styles.rowDisabled]}
                  onPress={() => toggle(item)}
                  disabled={isIn}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: isSelected(item.id) || isIn, disabled: isIn }}
                >
                  <View style={styles.icon}>
                    <Hash size={18} color={colors.accent} />
                  </View>
                  <View style={styles.rowText}>
                    <Text style={styles.name} numberOfLines={1}>
                      {item.name}
                    </Text>
                    <Text style={styles.sub} numberOfLines={1}>
                      {isIn ? 'Already added' : `${item.memberCount} member${item.memberCount === 1 ? '' : 's'}`}
                    </Text>
                  </View>
                  <Checkbox checked={isSelected(item.id) || isIn} onPress={() => toggle(item)} />
                </Pressable>
              );
            }}
          />
        )}

        <View style={styles.footer}>
          <Text style={styles.count}>Selected: {selected.length}</Text>
          {selected.length > 0 ? (
            <Pressable onPress={() => setSelected([])} hitSlop={8}>
              <Text style={styles.clear}>Clear</Text>
            </Pressable>
          ) : null}
        </View>
        <View style={styles.actions}>
          <Button title="Cancel" variant="ghost" onPress={close} style={styles.cancel} />
          <Button title={selected.length > 1 ? `Add ${selected.length} channels` : 'Add channel'} onPress={submit} disabled={selected.length === 0} style={styles.confirm} />
        </View>
      </View>
    </Modal>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    wrap: { gap: spacing.sm },
    chipScroll: { flexGrow: 0, flexShrink: 0 },
    chips: { gap: spacing.xs, paddingVertical: 2, alignItems: 'center' },
    chip: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, maxWidth: 180, paddingHorizontal: spacing.sm, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: colors.accentSoft },
    chipText: { fontSize: 13, color: colors.fg, flexShrink: 1 },
    list: { flex: 1 },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
    rowDisabled: { opacity: 0.55 },
    icon: { width: 38, height: 38, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft },
    rowText: { flex: 1, gap: 1 },
    name: { fontSize: 15, fontWeight: '600', color: colors.fg },
    sub: { fontSize: 12, color: colors.muted },
    footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    count: { fontSize: 13, color: colors.muted },
    clear: { fontSize: 13, fontWeight: '600', color: colors.accent },
    actions: { flexDirection: 'row', gap: spacing.sm },
    cancel: { flex: 1 },
    confirm: { flex: 2 },
  });
}
