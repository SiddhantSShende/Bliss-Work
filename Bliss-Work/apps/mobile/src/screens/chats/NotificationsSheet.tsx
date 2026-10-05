import { useMemo } from 'react';
import { Bell } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';
import { Modal } from '../../components/Modal';
import { ListEmpty } from '../../components/QueryState';
import { useNotifications, useReadAllNotifications } from '../../hooks/useNotifications';
import { EmptyState } from '../../components/EmptyState';
import { ListRow } from '../../components/ListRow';
import { timeAgo } from '../../lib/timeAgo';
import { type ThemeColors } from '../../constants/theme';
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
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { data: notifications = [], isLoading, isError, error, refetch } = useNotifications();
  const readAll = useReadAllNotifications();

  const handleClose = () => {
    if (notifications.some((n) => !n.read)) void readAll.mutate();
    onClose();
  };

  return (
    <Modal visible={visible} onClose={handleClose} title="Notifications" maxHeight="70%">
      {notifications.length === 0 ? (
        <ListEmpty
          isLoading={isLoading}
          isError={isError}
          error={error}
          onRetry={() => void refetch()}
          errorTitle="Unable to load notifications"
          loadingLabel="Loading notifications..."
          empty={<EmptyState icon={Bell} title="You're all caught up" subtitle="No notifications yet." />}
        />
      ) : (
        notifications.map((item) => (
          <ListRow
            key={item.id}
            title={item.text}
            subtitle={timeAgo(item.createdAt)}
            leading={<View style={[styles.dot, !item.read && styles.dotUnread]} />}
          />
        ))
      )}
    </Modal>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: 'transparent', marginTop: 6 },
    dotUnread: { backgroundColor: colors.accent },
  });
}
