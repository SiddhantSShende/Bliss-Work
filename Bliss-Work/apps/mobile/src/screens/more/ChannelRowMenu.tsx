import { useMemo } from 'react';
import { LogOut } from 'lucide-react-native';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLeaveChannel } from '../../hooks/useChannels';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';

interface ChannelRowMenuProps {
  visible: boolean;
  onClose: () => void;
  channelId: string;
  onLeft: () => void;
}

/** The channel header's "More" — channel twin of ChatRowMenu.tsx (Ignore/
 *  Clear chat/Block don't apply to a channel, so this is just Leave, the one
 *  channel-membership action that already exists as its own hook). */
export function ChannelRowMenu({ visible, onClose, channelId, onLeft }: ChannelRowMenuProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const leave = useLeaveChannel();

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={[styles.sheet, { marginBottom: insets.bottom + spacing.lg }]}>
          <Pressable
            style={styles.item}
            onPress={() => {
              onClose();
              leave.mutate(channelId, { onSuccess: onLeft });
            }}
          >
            <LogOut size={18} color={colors.danger} />
            <Text style={[styles.itemText, styles.danger]}>Leave Channel</Text>
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
    },
    itemText: { fontSize: 15, fontWeight: '500', color: colors.fg },
    danger: { color: colors.danger },
  });
}
