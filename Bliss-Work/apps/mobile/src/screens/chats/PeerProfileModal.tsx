import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Avatar } from '../../components/Avatar';
import { Modal } from '../../components/Modal';
import { spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';

interface PeerProfileModalProps {
  visible: boolean;
  onClose: () => void;
  peerName: string;
  online: boolean;
}

/** "View Profile" from the chat header menu — there is no standalone peer
 *  profile screen on mobile yet, so this shows exactly what the header
 *  itself already knows about the peer (name, presence) on the shared
 *  `Modal` sheet, rather than a screen backed by data this app doesn't
 *  fetch. */
export function PeerProfileModal({ visible, onClose, peerName, online }: PeerProfileModalProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <Modal visible={visible} onClose={onClose} title="Profile">
      <View style={styles.container}>
        <Avatar name={peerName} size={80} online={online} />
        <Text style={styles.name}>{peerName}</Text>
        <Text style={styles.status}>{online ? 'Online' : 'Offline'}</Text>
      </View>
    </Modal>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: {
      alignItems: 'center',
      gap: spacing.sm,
      paddingBottom: spacing.lg,
    },
    name: {
      fontSize: 18,
      fontWeight: '700',
      color: colors.fg,
      marginTop: spacing.xs,
    },
    status: {
      fontSize: 13,
      color: colors.muted,
    },
  });
}
