import { useMemo, useState } from 'react';
import { Users, X } from 'lucide-react-native';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { UserDTO } from '@taskboard/shared';
import { useDirectory } from '../hooks/useDirectory';
import { usePresence } from '../hooks/usePresence';
import { Avatar } from './Avatar';
import { Button } from './Button';
import { Checkbox } from './Checkbox';
import { EmptyState } from './EmptyState';
import { ErrorState, LoadingState } from './QueryState';
import { Modal } from './Modal';
import { SearchInput } from './SearchInput';
import { radius, spacing, type ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';

export interface MemberPickerSheetProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  /** Confirm-button label for N selected (default: "Add" / "Add N"). */
  confirmLabel?: (count: number) => string;
  /** Members already in the call/meeting/etc.: shown disabled, tagged, never selectable (no duplicates). */
  alreadyIds?: readonly string[];
  alreadyLabel?: string;
  /** Called with every selected member on confirm. The sheet closes afterwards, success or not. */
  onConfirm: (users: UserDTO[]) => void | Promise<unknown>;
  /** Only one member may be chosen (selecting another replaces the choice). */
  single?: boolean;
}

/**
 * Real workspace-member picker on the glass sheet: search, avatar, name, presence
 * and role, a checkmark per selected member, chips + "Selected: N", Clear,
 * Cancel and a confirm button that stays disabled until someone is chosen.
 * Members come from `api.directory()` (useDirectory) — the same source Home,
 * Forward and task assignment use — so there is no static or second member list.
 */
export function MemberPickerSheet({
  visible,
  onClose,
  title,
  confirmLabel,
  alreadyIds = [],
  alreadyLabel = 'Already added',
  onConfirm,
  single,
}: MemberPickerSheetProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { height } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<UserDTO[]>([]);
  const [busy, setBusy] = useState(false);
  const { all, filtered, isLoading, isError, error, refetch } = useDirectory(query);
  const online = usePresence(filtered.map((u) => u.id));

  const already = useMemo(() => new Set(alreadyIds), [alreadyIds]);
  const isSelected = (id: string) => selected.some((u) => u.id === id);
  const toggle = (u: UserDTO) => {
    if (already.has(u.id)) return;
    setSelected((prev) => {
      if (prev.some((p) => p.id === u.id)) return prev.filter((p) => p.id !== u.id);
      return single ? [u] : [...prev, u];
    });
  };

  const reset = () => {
    setQuery('');
    setSelected([]);
    setBusy(false);
  };
  const close = () => {
    reset();
    onClose();
  };
  const submit = async () => {
    if (selected.length === 0 || busy) return;
    setBusy(true);
    try {
      await onConfirm(selected);
    } finally {
      reset();
      onClose();
    }
  };

  const label = confirmLabel ? confirmLabel(selected.length) : selected.length > 1 ? `Add ${selected.length}` : 'Add';

  return (
    <Modal visible={visible} onClose={close} title={title} scroll={false} maxHeight="85%">
      <View style={[styles.wrap, { height: Math.min(540, Math.round(height * 0.64)) }]}>
        <SearchInput value={query} onChangeText={setQuery} placeholder="Search people..." />

        {selected.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled">
            {selected.map((u) => (
              <Pressable key={u.id} onPress={() => toggle(u)} style={styles.chip} accessibilityLabel={`Remove ${u.displayName}`}>
                <Text style={styles.chipText} numberOfLines={1}>
                  {u.displayName}
                </Text>
                <X size={13} color={colors.accent} />
              </Pressable>
            ))}
          </ScrollView>
        ) : null}

        {isLoading ? (
          <LoadingState label="Loading people..." />
        ) : isError && all.length === 0 ? (
          <ErrorState title="Unable to load people" error={error} onRetry={() => void refetch()} />
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={(u) => u.id}
            style={styles.list}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={<EmptyState icon={Users} title={all.length === 0 ? 'No other members in this workspace' : 'No matches'} />}
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
                  <Avatar name={item.displayName} src={item.avatarUrl} size={38} online={online.has(item.id)} />
                  <View style={styles.rowText}>
                    <Text style={styles.name} numberOfLines={1}>
                      {item.displayName}
                    </Text>
                    <Text style={styles.sub} numberOfLines={1}>
                      {isIn ? alreadyLabel : `${item.roles.includes('org_admin') ? 'Admin' : 'Member'} · ${online.has(item.id) ? 'Online' : 'Offline'}`}
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
          <Button title={label} onPress={() => void submit()} disabled={selected.length === 0} loading={busy} style={styles.confirm} />
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
    chip: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, maxWidth: 160, paddingHorizontal: spacing.sm, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: colors.accentSoft },
    chipText: { fontSize: 13, color: colors.fg, flexShrink: 1 },
    list: { flex: 1 },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
    rowDisabled: { opacity: 0.55 },
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
