import { useMemo } from 'react';
import { Copy, CornerUpLeft, Forward, ListChecks, Pin, PinOff, Plus, Trash, Trash2, type LucideIcon } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Modal } from '../../components/Modal';
import { MenuItem } from '../../components/MenuItem';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';

/** Same set web's EmojiPicker.tsx quick-reacts with
 *  (packages/app/src/features/EmojiPicker.tsx) — kept identical so a reaction
 *  added from mobile looks like one a teammate could have added from web. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '😮', '🙏'];

interface MessageActionSheetProps {
  visible: boolean;
  onClose: () => void;
  mine: boolean;
  /** Channel messages only — omitted entirely for DMs (no pin concept there). */
  canPin?: boolean;
  isPinned?: boolean;
  /** DM: sender only. Channel: sender or moderator — the caller has already
   *  worked out which applies (server re-checks regardless). */
  canDeleteForAll: boolean;
  onQuickReact: (emoji: string) => void;
  onOpenFullPicker: () => void;
  onReply: () => void;
  onForward: () => void;
  /** Present only for messages that have copyable text. */
  onCopy?: () => void;
  onSelect: () => void;
  onTogglePin?: () => void;
  onDeleteForMe: () => void;
  onDeleteForAll: () => void;
}

/**
 * Long-press a message → this sheet: a quick-react row (identical set to
 * web's) plus "+" for the full picker, then the message's own actions —
 * "the existing additional message actions supported by BlissWork" (Reply/
 * Forward/Select/Pin/Delete), all against APIs the app already has. Shared
 * by both ChatConversationScreen and ChannelConversationScreen — `canPin`/
 * `onTogglePin` are the only channel-specific bits, and DMs simply omit
 * them.
 */
export function MessageActionSheet({
  visible,
  onClose,
  mine,
  canPin,
  isPinned,
  canDeleteForAll,
  onQuickReact,
  onOpenFullPicker,
  onReply,
  onForward,
  onCopy,
  onSelect,
  onTogglePin,
  onDeleteForMe,
  onDeleteForAll,
}: MessageActionSheetProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const run = (action: () => void) => {
    action();
    onClose();
  };

  const actions: { key: string; label: string; icon: LucideIcon; danger?: boolean; onPress: () => void }[] = [
    { key: 'reply', label: 'Reply', icon: CornerUpLeft, onPress: onReply },
    { key: 'forward', label: 'Forward', icon: Forward, onPress: onForward },
    ...(onCopy ? [{ key: 'copy', label: 'Copy', icon: Copy, onPress: onCopy }] : []),
    { key: 'select', label: 'Select', icon: ListChecks, onPress: onSelect },
  ];
  if (canPin && onTogglePin) {
    actions.push({ key: 'pin', label: isPinned ? 'Unpin' : 'Pin', icon: isPinned ? PinOff : Pin, onPress: onTogglePin });
  }
  actions.push({ key: 'deleteForMe', label: 'Delete for me', icon: Trash, onPress: onDeleteForMe });
  if (canDeleteForAll) {
    actions.push({ key: 'deleteForAll', label: 'Delete for everyone', icon: Trash2, danger: true, onPress: onDeleteForAll });
  }

  return (
    <Modal visible={visible} onClose={onClose}>
      <View style={[styles.quickRow, mine && styles.quickRowMine]}>
        {QUICK_REACTIONS.map((emoji) => (
          <Pressable key={emoji} onPress={() => run(() => onQuickReact(emoji))} style={styles.quickEmoji} accessibilityLabel={`React ${emoji}`}>
            <Text style={styles.quickEmojiText}>{emoji}</Text>
          </Pressable>
        ))}
        <Pressable onPress={() => run(onOpenFullPicker)} style={[styles.quickEmoji, styles.morePicker]} accessibilityLabel="More reactions">
          <Plus size={18} color={colors.muted} />
        </Pressable>
      </View>

      {actions.map((action, index) => (
        <MenuItem key={action.key} icon={action.icon} label={action.label} danger={action.danger} divider={index < actions.length - 1} onPress={() => run(action.onPress)} />
      ))}
    </Modal>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    quickRow: {
      flexDirection: 'row',
      justifyContent: 'flex-start',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: spacing.xs,
      paddingBottom: spacing.sm,
      marginBottom: spacing.xs,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    quickRowMine: { justifyContent: 'flex-end' },
    quickEmoji: { width: 42, height: 42, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
    morePicker: { backgroundColor: colors.surface2 },
    quickEmojiText: { fontSize: 22 },
  });
}
