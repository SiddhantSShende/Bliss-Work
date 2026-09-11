import { useMemo, useState } from 'react';
import { ArrowLeft, Bell, HelpCircle, Info, LogOut, Palette, ShieldCheck, User } from 'lucide-react-native';
import { Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { useSession } from '@taskboard/app/store/session';
import { signOut } from '../../services/auth';
import { Avatar } from '../../components/Avatar';
import { Card } from '../../components/Card';
import { ListRow } from '../../components/ListRow';
import { Badge } from '../../components/Badge';
import { useNotifications } from '../../hooks/useNotifications';
import { spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';
import type { MoreStackParamList } from '../../navigation/types';
import { ThemePickerModal } from './ThemePickerModal';
import { NotificationsSheet } from '../chats/NotificationsSheet';

type Props = NativeStackScreenProps<MoreStackParamList, 'Account'>;

/** The real BlissWork contact address — reused from the website's own legal/
 *  security contact (Bliss-Website/src/components/legal/LegalDoc.tsx), not
 *  a fabricated support inbox. */
const SUPPORT_EMAIL = 'siddhant.shende@consultrnr.com';

/**
 * The account hub — mirrors the reference's "Profile" screen: large avatar,
 * name/email, then My Profile / Notifications / Theme / Privacy & Security /
 * Help & Support / About BlissWork, and Sign out. Every row opens something
 * real that already exists elsewhere in this app; nothing here is new state.
 */
export function AccountScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { api } = useRuntime();
  const user = useSession((s) => s.user);
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const { data: notifications } = useNotifications();
  const notificationsUnread = notifications?.filter((n) => !n.read).length ?? 0;

  const confirmSignOut = () => {
    Alert.alert('Sign out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void signOut(api) },
    ]);
  };

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
          <ArrowLeft size={22} color={colors.fg} />
        </Pressable>
        <Text style={styles.headerTitle}>Profile</Text>
        <View style={{ width: 22 }} />
      </View>

      <View style={styles.content}>
        <View style={styles.identity}>
          <Avatar name={user?.displayName ?? '?'} src={user?.avatarUrl} size={84} />
          <Text style={styles.name}>{user?.displayName}</Text>
          <Text style={styles.email}>{user?.email}</Text>
        </View>

        <Card noPadding>
          <ListRow
            leading={<User size={18} color={colors.accent} />}
            title="My Profile"
            onPress={() => navigation.navigate('Profile')}
          />
          <View style={styles.divider} />
          <ListRow
            leading={<Bell size={18} color={colors.accent} />}
            title="Notifications"
            trailing={notificationsUnread ? <Badge count={notificationsUnread} /> : undefined}
            onPress={() => setNotificationsOpen(true)}
          />
          <View style={styles.divider} />
          <ListRow
            leading={<Palette size={18} color={colors.accent} />}
            title="Theme"
            onPress={() => setThemePickerOpen(true)}
          />
          <View style={styles.divider} />
          <ListRow
            leading={<ShieldCheck size={18} color={colors.accent} />}
            title="Privacy & Security"
            onPress={() => navigation.navigate('Settings')}
          />
          <View style={styles.divider} />
          <ListRow
            leading={<HelpCircle size={18} color={colors.accent} />}
            title="Help & Support"
            onPress={() => void Linking.openURL(`mailto:${SUPPORT_EMAIL}`)}
          />
          <View style={styles.divider} />
          <ListRow
            leading={<Info size={18} color={colors.accent} />}
            title="About BlissWork"
            onPress={() => navigation.navigate('About')}
          />
        </Card>

        <Pressable onPress={confirmSignOut} style={styles.logoutBtn}>
          <LogOut size={18} color={colors.danger} />
          <Text style={styles.logoutText}>Log Out</Text>
        </Pressable>
      </View>

      <ThemePickerModal visible={themePickerOpen} onClose={() => setThemePickerOpen(false)} />
      <NotificationsSheet visible={notificationsOpen} onClose={() => setNotificationsOpen(false)} />
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    headerTitle: { fontSize: 16, fontWeight: '700', color: colors.fg },
    content: { padding: spacing.lg, gap: spacing.lg },
    identity: { alignItems: 'center', gap: 4, paddingVertical: spacing.md },
    name: { fontSize: 18, fontWeight: '700', color: colors.fg, marginTop: spacing.sm },
    email: { fontSize: 13, color: colors.muted },
    divider: {
      height: 1,
      backgroundColor: colors.border,
      marginLeft: spacing.md + 18 + spacing.md,
    },
    logoutBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.md,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.danger,
    },
    logoutText: { fontSize: 15, fontWeight: '700', color: colors.danger },
  });
}
