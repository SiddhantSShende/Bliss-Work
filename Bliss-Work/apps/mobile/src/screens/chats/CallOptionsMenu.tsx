import { useMemo } from 'react';
import { Calendar, Link2, Phone, Video } from 'lucide-react-native';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';

interface CallOptionsMenuProps {
  visible: boolean;
  onClose: () => void;
  onVoiceCall: () => void;
  onVideoCall: () => void;
  onSendCallLink: () => void;
  onScheduleCall: () => void;
}

/** The chat header's phone-icon menu: voice/video call now, share a
 *  joinable link, or schedule one for later — same bottom-sheet shape as
 *  ChatRowMenu's three-dot menu. */
export function CallOptionsMenu({
  visible,
  onClose,
  onVoiceCall,
  onVideoCall,
  onSendCallLink,
  onScheduleCall,
}: CallOptionsMenuProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();

  const run = (action: () => void) => {
    action();
    onClose();
  };

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={[styles.sheet, { marginBottom: insets.bottom + spacing.lg }]}>
          <Pressable style={styles.item} onPress={() => run(onVoiceCall)}>
            <Phone size={18} color={colors.fg} />
            <Text style={styles.itemText}>Voice Call</Text>
          </Pressable>
          <Pressable style={styles.item} onPress={() => run(onVideoCall)}>
            <Video size={18} color={colors.fg} />
            <Text style={styles.itemText}>Video Call</Text>
          </Pressable>
          <Pressable style={styles.item} onPress={() => run(onSendCallLink)}>
            <Link2 size={18} color={colors.fg} />
            <Text style={styles.itemText}>Send Call Link</Text>
          </Pressable>
          <Pressable style={[styles.item, styles.lastItem]} onPress={() => run(onScheduleCall)}>
            <Calendar size={18} color={colors.fg} />
            <Text style={styles.itemText}>Schedule Call</Text>
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
    lastItem: { borderBottomWidth: 0 },
    itemText: { fontSize: 15, fontWeight: '500', color: colors.fg },
  });
}
