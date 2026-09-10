import { useMemo, type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Logo } from '../../components/Logo';
import { spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';

/**
 * Shared chrome for every signed-out screen (Login, MFA challenge): centered
 * logo, title, optional subtitle, then the screen's own form below.
 *
 * Deliberately NOT a port of AuthLayout's desktop split-pane hero — that
 * panel is `hidden lg:flex` even on web, i.e. it's already considered
 * decoration a narrow viewport doesn't get. A phone screen is that narrow
 * viewport, so this is the mobile-native equivalent: the branded header a
 * phone auth screen normally has, not a shrunk two-column layout.
 */
export function AuthScreenLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <Logo size={40} />
          <Text style={styles.title}>{title}</Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        </View>
        <View style={styles.form}>{children}</View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: colors.bg },
    content: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.xl },
    header: { alignItems: 'center', gap: spacing.sm },
    title: { fontSize: 22, fontWeight: '700', color: colors.fg, marginTop: spacing.sm },
    subtitle: { fontSize: 14, color: colors.muted, textAlign: 'center' },
    form: { gap: spacing.md },
  });
}
