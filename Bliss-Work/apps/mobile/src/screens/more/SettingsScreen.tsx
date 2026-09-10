import { useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, Eye, Info, Moon, Palette, ShieldCheck, Sun } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Card } from '../../components/Card';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import { useAppTheme } from '../../theme/ThemeProvider';
import { familyName } from '../../theme/themes';
import type { MoreStackParamList } from '../../navigation/types';
import { ThemePickerModal } from './ThemePickerModal';
// Metro/TS resolve JSON imports statically at build time (resolveJsonModule
// in the base RN tsconfig) — the same real, already-existing version string
// apps/mobile ships under, not a hardcoded/fake one.
import pkg from '../../../package.json';

type Props = NativeStackScreenProps<MoreStackParamList, 'Settings'>;

/**
 * Settings — mirrors packages/app/src/routes/Settings.tsx (web) one setting
 * at a time: Theme, Two-factor authentication, Active sessions, Your
 * activity, About. "Desktop notifications" is deliberately NOT reproduced
 * here — it gates `window.Notification` toast popups
 * (packages/app/src/lib/callNotify.ts) and an Electron-only OS mirror
 * (PlatformConfig.notificationPrefs); neither exists on this platform, and
 * this app has no push/local-notification system of its own for a toggle to
 * control, so a mobile copy of that switch would flip nothing real. Sign out
 * lives in More (the account menu), same split as web (ProfileMenu vs. this
 * page).
 */
export function SettingsScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const { colors, isDark, family } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [themePickerOpen, setThemePickerOpen] = useState(false);

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
          <ArrowLeft size={22} color={colors.fg} />
        </Pressable>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={{ width: 22 }} />
      </View>

      <View style={styles.content}>
        <SettingRow
          colors={colors}
          icon={<Palette size={18} color={colors.muted} />}
          title="Theme"
          description={`${familyName(family)} · ${isDark ? 'Dark' : 'Light'}`}
          action={
            <Pressable onPress={() => setThemePickerOpen(true)} style={styles.linkBtn}>
              {isDark ? <Moon size={14} color={colors.fg} /> : <Sun size={14} color={colors.fg} />}
            </Pressable>
          }
        />

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
          icon={<Info size={18} color={colors.muted} />}
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

        <SettingRow colors={colors} icon={<Info size={18} color={colors.muted} />} title="About" description={`BlissWork ${pkg.version} · mobile`} />
      </View>

      <ThemePickerModal visible={themePickerOpen} onClose={() => setThemePickerOpen(false)} />
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
