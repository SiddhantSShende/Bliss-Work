import { useMemo } from 'react';
import { Bell } from 'lucide-react-native';
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NotificationDTO } from '@taskboard/shared';
import { useNotifications, useReadAllNotifications } from '../../hooks/useNotifications';
import { EmptyState } from '../../components/EmptyState';
import { ListRow } from '../../components/ListRow';
import { timeAgo } from '../../lib/timeAgo';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';

interface NotificationsSheetProps {
  visible: boolean;
  onClose: () => void;
}

/** Notification list opened from Chats' bell icon (formerly Home's, before
 *  Home was removed from the bottom nav). Marks everything read on CLOSE,
 *  not open — same deliberate choice web's `NotificationsPanel` makes, so a
 *  glanced-at notification stays visibly unread while the sheet is open. */
export function NotificationsSheet({ visible, onClose }: NotificationsSheetProps) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { data: notifications = [] } = useNotifications();
  const readAll = useReadAllNotifications();

  const handleClose = () => {
    if (notifications.some((n) => !n.read)) void readAll.mutate();
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose}>
      <Pressable style={styles.backdrop} onPress={handleClose} />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.lg }]}>
        <View style={styles.handle} />
        <Text style={styles.title}>Notifications</Text>
        <FlatList<NotificationDTO>
          data={notifications}
          keyExtractor={(n) => n.id}
          style={styles.list}
          ListEmptyComponent={
            <EmptyState icon={Bell} title="You're all caught up" subtitle="No notifications yet." />
          }
          renderItem={({ item }) => (
            <ListRow
              title={item.text}
              subtitle={timeAgo(item.createdAt)}
              leading={<View style={[styles.dot, !item.read && styles.dotUnread]} />}
            />
          )}
        />
      </View>
    </Modal>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.35)',
    },
    sheet: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: radius.card,
      borderTopRightRadius: radius.card,
      maxHeight: '70%',
      paddingTop: spacing.sm,
    },
    handle: {
      alignSelf: 'center',
      width: 40,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.border,
      marginBottom: spacing.sm,
    },
    title: {
      fontSize: 17,
      fontWeight: '700',
      color: colors.fg,
      paddingHorizontal: spacing.lg,
      marginBottom: spacing.xs,
    },
    list: {
      paddingHorizontal: spacing.sm,
    },
    dot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: 'transparent',
      marginTop: 6,
    },
    dotUnread: {
      backgroundColor: colors.accent,
    },
  });
}
