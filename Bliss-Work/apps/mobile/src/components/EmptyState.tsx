import { useMemo } from 'react';
import type { LucideIcon } from 'lucide-react-native';
import { StyleSheet, Text, View } from 'react-native';
import { spacing, type ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
}

/** Icon + message for an empty list — mirrors web's `EmptyState`, styled for
 *  a centered mobile panel rather than a wide desktop pane. */
export function EmptyState({ icon: Icon, title, subtitle }: EmptyStateProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.container}>
      <View style={styles.iconWrap}>
        <Icon size={28} color={colors.accent} />
      </View>
      <Text style={styles.title}>{title}</Text>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: {
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing['2xl'],
      gap: spacing.xs,
    },
    iconWrap: {
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: colors.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing.sm,
    },
    title: {
      fontSize: 15,
      fontWeight: '600',
      color: colors.fg,
      textAlign: 'center',
    },
    subtitle: {
      fontSize: 13,
      color: colors.muted,
      textAlign: 'center',
    },
  });
}
