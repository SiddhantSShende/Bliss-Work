import { useMemo, useState } from 'react';
import { Users } from 'lucide-react-native';
import { FlatList, Pressable, StyleSheet, Text } from 'react-native';
import type { UserDTO } from '@taskboard/shared';
import { useDirectory } from '../../hooks/useDirectory';
import { Avatar } from '../../components/Avatar';
import { EmptyState } from '../../components/EmptyState';
import { Modal } from '../../components/Modal';
import { SearchInput } from '../../components/SearchInput';
import { spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';

interface ForwardMessageSheetProps {
  visible: boolean;
  onClose: () => void;
  onPick: (user: UserDTO) => void;
}

/** "Forward" from a message's action sheet — the same org-directory picker
 *  NewChatScreen already uses, restricted to a single tap-to-forward pick
 *  rather than NewChatScreen's multi-select, so it fits a modal instead of a
 *  full screen. People only, not channels — a channel target picker is a
 *  separate feature this change doesn't add. */
export function ForwardMessageSheet({ visible, onClose, onPick }: ForwardMessageSheetProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [query, setQuery] = useState('');
  const { filtered, isLoading } = useDirectory(query);

  return (
    <Modal visible={visible} onClose={onClose} title="Forward to..." maxHeight="70%">
      <SearchInput value={query} onChangeText={setQuery} placeholder="Search people..." />
      <FlatList
        data={filtered}
        keyExtractor={(u) => u.id}
        style={styles.list}
        ListEmptyComponent={!isLoading ? <EmptyState icon={Users} title="No matches" /> : null}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => onPick(item)}>
            <Avatar name={item.displayName} src={item.avatarUrl} size={36} />
            <Text style={styles.name} numberOfLines={1}>
              {item.displayName}
            </Text>
          </Pressable>
        )}
      />
    </Modal>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    list: { marginTop: spacing.sm, flexGrow: 0 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm,
    },
    name: { flex: 1, fontSize: 15, fontWeight: '600', color: colors.fg },
  });
}
