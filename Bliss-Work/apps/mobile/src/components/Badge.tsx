import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { radius, type ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';

interface BadgeProps {
  /** Nothing renders for count <= 0 — callers don't need their own guard. */
  count: number;
}

/** Small red count pill for unread messages / notifications, capped at "99+"
 *  — same cap web's `Rail.tsx` already uses, kept identical for consistency. */
export function Badge({ count }: BadgeProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  if (count <= 0) return null;
  return (
    <View style={styles.badge}>
      <Text style={styles.text}>{count > 99 ? '99+' : count}</Text>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    badge: {
      minWidth: 18,
      height: 18,
      paddingHorizontal: 4,
      borderRadius: radius.pill,
      backgroundColor: colors.danger,
      alignItems: 'center',
      justifyContent: 'center',
    },
    text: {
      color: '#ffffff',
      fontSize: 11,
      fontWeight: '700',
    },
  });
}
