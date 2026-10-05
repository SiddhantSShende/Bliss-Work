import { useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, Bell, Eye, HelpCircle, Info, Palette, ShieldCheck } from 'lucide-react-native';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Card } from '../../components/Card';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';
import type { MoreStackParamList } from '../../navigation/types';
import { useNotifications } from '../../hooks/useNotifications';
import { useAppTheme } from '../../theme/ThemeProvider';
import { familyName } from '../../theme/themes';
import { Badge } from '../../components/Badge';
import { ThemePickerModal } from './ThemePickerModal';
import { NotificationsSheet } from '../chats/NotificationsSheet';

const SUPPORT_EMAIL = 'siddhant.shende@consultrnr.com';

type Props = NativeStackScreenProps<MoreStackParamList, 'Settings'>;

/**
 * Privacy & Security — mirrors the security-relevant slice of
 * packages/app/src/routes/Settings.tsx (web): two-factor authentication,
 * active sessions, activity log. Theme and About moved to the account hub
 * (AccountScreen) to match the reference's split between "More" (workspace/
 * comms) and "Profile" (account); this screen keeps only what the reference
 * calls "Privacy & Security".
 */
export function SettingsScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { family, mode } = useAppTheme();
  const [themeOpen, setThemeOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const { data: notifications } = useNotifications();
  const unread = notifications?.filter((n) => !n.read).length ?? 0;

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
          <ArrowLeft size={22} color={colors.fg} />
        </Pressable>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={{ width: 22 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.sectionLabel}>Preferences</Text>
        <SettingRow
          colors={colors}
          icon={<Palette size={18} color={colors.muted} />}
          title="Theme"
          description={`${familyName(family)} · ${mode === 'dark' ? 'Dark' : 'Light'}`}
          action={
            <Pressable onPress={() => setThemeOpen(true)} style={styles.linkBtn} accessibilityRole="button">
              <Text style={styles.linkBtnText}>Change</Text>
            </Pressable>
          }
        />
        <SettingRow
          colors={colors}
          icon={<Bell size={18} color={colors.muted} />}
          title="Notifications"
          description="Task, channel and mail alerts."
          action={
            <Pressable onPress={() => setNotificationsOpen(true)} style={styles.linkBtn} accessibilityRole="button">
              {unread ? <Badge count={unread} /> : <Text style={styles.linkBtnText}>View</Text>}
            </Pressable>
          }
        />

        <Text style={styles.sectionLabel}>Privacy & Security</Text>
        <SettingRow
          colors={colors}
          icon={<ShieldCheck size={18} color={colors.muted} />}
          title="Two-factor authentication"
          description="Add an authenticator app as a second sign-in step."
          action={
            <Pressable onPress={() => navigation.navigate('MfaSettings')} style={styles.linkBtn}>
              <Text style={styles.linkBtnText}>Manage</Text>
            </Pressable>
          }
        />

        <SettingRow
          colors={colors}
          icon={<ShieldCheck size={18} color={colors.muted} />}
          title="Active sessions"
          description="See every device signed in to your account."
          action={
            <Pressable onPress={() => navigation.navigate('ActiveSessions')} style={styles.linkBtn}>
              <Text style={styles.linkBtnText}>View</Text>
            </Pressable>
          }
        />

        <SettingRow
          colors={colors}
          icon={<Eye size={18} color={colors.muted} />}
          title="Your activity"
          description="See everything BlissWork records about how you work."
          action={
            <Pressable onPress={() => navigation.navigate('MyActivity')} style={styles.linkBtn}>
              <Text style={styles.linkBtnText}>View</Text>
            </Pressable>
          }
        />

        <Text style={styles.sectionLabel}>Support</Text>
        <SettingRow
          colors={colors}
          icon={<HelpCircle size={18} color={colors.muted} />}
          title="Help & Support"
          description="Email the BlissWork support team."
          action={
            <Pressable onPress={() => void Linking.openURL(`mailto:${SUPPORT_EMAIL}`)} style={styles.linkBtn} accessibilityRole="button">
              <Text style={styles.linkBtnText}>Contact</Text>
            </Pressable>
          }
        />
        <SettingRow
          colors={colors}
          icon={<Info size={18} color={colors.muted} />}
          title="About BlissWork"
          description="Version and legal information."
          action={
            <Pressable onPress={() => navigation.navigate('About')} style={styles.linkBtn} accessibilityRole="button">
              <Text style={styles.linkBtnText}>View</Text>
            </Pressable>
          }
        />
      </ScrollView>

      <ThemePickerModal visible={themeOpen} onClose={() => setThemeOpen(false)} />
      <NotificationsSheet visible={notificationsOpen} onClose={() => setNotificationsOpen(false)} />
    </View>
  );
}

function SettingRow({
  colors,
  icon,
  title,
  description,
  action,
}: {
  colors: ThemeColors;
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <Card style={styles.row}>
      <View style={styles.rowIcon}>{icon}</View>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowDescription}>{description}</Text>
      </View>
      {action}
    </Card>
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
    content: { padding: spacing.lg, gap: spacing.md },
    sectionLabel: { fontSize: 12, fontWeight: '700', color: colors.muted, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: spacing.sm },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    rowIcon: {
      width: 40,
      height: 40,
      borderRadius: 12,
      backgroundColor: colors.surface2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rowText: { flex: 1, gap: 2 },
    rowTitle: { fontSize: 14, fontWeight: '600', color: colors.fg },
    rowDescription: { fontSize: 12, color: colors.muted },
    linkBtn: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderRadius: radius.pill,
      backgroundColor: colors.surface2,
    },
    linkBtnText: { fontSize: 13, fontWeight: '600', color: colors.fg },
  });
}
