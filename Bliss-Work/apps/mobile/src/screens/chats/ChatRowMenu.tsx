import { useMemo } from 'react';
import { Ban, EyeOff, Trash2 } from 'lucide-react-native';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { qk } from '../../hooks/queryKeys';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';

interface ChatRowMenuProps {
  visible: boolean;
  onClose: () => void;
  conversationId: string;
  peerId: string;
  blockedByMe: boolean;
}

/** The three-dot menu on a chat row: ignore/clear/block, all real
 *  `ApiClient` calls. `ignoreConversation` is used (over the newer
 *  `ignoreThread`) because `ConversationDTO` carries a `conversationId`, not
 *  a `threadId` — and its own doc comment says it's "kept working for
 *  /chats" specifically for this reason. */
export function ChatRowMenu({ visible, onClose, conversationId, peerId, blockedByMe }: ChatRowMenuProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { api } = useRuntime();
  const qc = useQueryClient();

  const invalidate = () => void qc.invalidateQueries({ queryKey: qk.conversations });
  const ignore = useMutation({ mutationFn: () => api.ignoreConversation(conversationId), onSuccess: invalidate });
  const clear = useMutation({ mutationFn: () => api.clearConversation(conversationId), onSuccess: invalidate });
  const toggleBlock = useMutation({
    mutationFn: () => (blockedByMe ? api.unblockUser(peerId) : api.blockUser(peerId)),
    onSuccess: invalidate,
  });

  const run = (mutate: () => void) => {
    mutate();
    onClose();
  };

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={[styles.sheet, { marginBottom: insets.bottom + spacing.lg }]}>
          <Pressable style={styles.item} onPress={() => run(() => ignore.mutate())}>
            <EyeOff size={18} color={colors.fg} />
            <Text style={styles.itemText}>Ignore</Text>
          </Pressable>
          <Pressable style={styles.item} onPress={() => run(() => clear.mutate())}>
            <Trash2 size={18} color={colors.fg} />
            <Text style={styles.itemText}>Clear chat</Text>
          </Pressable>
          <Pressable style={styles.item} onPress={() => run(() => toggleBlock.mutate())}>
            <Ban size={18} color={colors.danger} />
            <Text style={[styles.itemText, styles.danger]}>{blockedByMe ? 'Unblock' : 'Block'}</Text>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.35)',
      justifyContent: 'flex-end',
    },
    sheet: {
      marginHorizontal: spacing.lg,
      backgroundColor: colors.surface,
      borderRadius: radius.card,
      overflow: 'hidden',
    },
    item: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    itemText: { fontSize: 15, fontWeight: '500', color: colors.fg },
    danger: { color: colors.danger },
  });
}
