import { useMemo } from 'react';
import type { LucideIcon } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { spacing, type ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';

interface MenuItemProps {
  icon?: LucideIcon;
  label: string;
  onPress: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Draws a divider under the row (skip it on the last one). */
  divider?: boolean;
}

/** One tappable row of a popup action list — used inside the glass `Modal`. */
export function MenuItem({ icon: Icon, label, onPress, danger, disabled, divider = true }: MenuItemProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const color = danger ? colors.danger : colors.fg;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => [styles.item, divider && styles.divider, pressed && styles.pressed, disabled && styles.disabled]}
    >
      {Icon ? <Icon size={18} color={color} /> : null}
      <View style={styles.textWrap}>
        <Text style={[styles.text, { color }]} numberOfLines={1}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    item: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      minHeight: 48,
      paddingHorizontal: spacing.xs,
      paddingVertical: spacing.sm,
    },
    divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    pressed: { opacity: 0.6 },
    disabled: { opacity: 0.4 },
    textWrap: { flex: 1 },
    text: { fontSize: 15, fontWeight: '500' },
  });
}
