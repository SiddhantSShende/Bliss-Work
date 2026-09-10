import { useMemo } from 'react';
import { LogOut, Moon, Settings as SettingsIcon, User } from 'lucide-react-native';
import { Alert, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useRuntime } from '@taskboard/app/lib/runtime';
import { useSession } from '@taskboard/app/store/session';
import { signOut } from '../../services/auth';
import { Avatar } from '../../components/Avatar';
import { Card } from '../../components/Card';
import { ListRow } from '../../components/ListRow';
import { spacing, type ThemeColors } from '../../constants/theme';
import { useAppTheme } from '../../theme/ThemeProvider';
import type { MoreStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<MoreStackParamList, 'MoreMenu'>;

/**
 * The More tab's landing screen: the account menu (mirrors web's
 * ProfileMenu.tsx) — Profile, Settings, Dark Theme, Sign out. Mail/Channels/
 * Members/Org used to live here (and, before that, on the removed Home
 * screen); they're reachable from Chats' header icon now (WorkspaceScreen),
 * since this screen is the account menu, not a feature grid.
 */
export function MoreMenuScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { api } = useRuntime();
  const user = useSession((s) => s.user);
  const { colors, isDark, toggle } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const confirmSignOut = () => {
    Alert.alert('Sign out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void signOut(api) },
    ]);
  };

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <Text style={styles.header}>More</Text>

      <View style={styles.content}>
        <Card style={styles.profileCard}>
          <Avatar name={user?.displayName ?? '?'} src={user?.avatarUrl} size={56} />
          <Text style={styles.name}>{user?.displayName}</Text>
          <Text style={styles.email}>{user?.email}</Text>
        </Card>

        <Card noPadding>
          <ListRow
            leading={<User size={18} color={colors.accent} />}
            title="Profile"
            onPress={() => navigation.navigate('Profile')}
          />
          <View style={styles.divider} />
          <ListRow
            leading={<SettingsIcon size={18} color={colors.accent} />}
            title="Settings"
            onPress={() => navigation.navigate('Settings')}
          />
          <View style={styles.divider} />
          <ListRow
            leading={<Moon size={18} color={colors.accent} />}
            title="Dark Theme"
            trailing={
              <Switch
                value={isDark}
                onValueChange={toggle}
                trackColor={{ false: colors.border, true: colors.accent }}
                thumbColor={colors.surface}
              />
            }
          />
        </Card>

        <Card noPadding>
          <ListRow
            leading={<LogOut size={18} color={colors.danger} />}
            title="Sign out"
            onPress={confirmSignOut}
          />
        </Card>
      </View>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: colors.bg },
    header: {
      fontSize: 22,
      fontWeight: '700',
      color: colors.fg,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      paddingBottom: spacing.md,
    },
    content: { paddingHorizontal: spacing.lg, gap: spacing.md },
    profileCard: { alignItems: 'center', gap: 4, paddingVertical: spacing.xl },
    name: { fontSize: 16, fontWeight: '700', color: colors.fg, marginTop: spacing.xs },
    email: { fontSize: 13, color: colors.muted },
    divider: {
      height: 1,
      backgroundColor: colors.border,
      marginLeft: spacing.md + 18 + spacing.md,
    },
  });
}
