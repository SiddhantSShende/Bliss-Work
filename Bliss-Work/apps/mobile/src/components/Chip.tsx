import { useMemo } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { radius, spacing, type ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';

interface ChipProps {
  label: string;
  active?: boolean;
  onPress: () => void;
}

/** A single filter pill — active state fills with the accent color, inactive
 *  sits on the neutral surface-2 tone. Generic building block for any
 *  screen's filter row (a new screen wanting one no longer hand-rolls it). */
export function Chip({ label, active, onPress }: ChipProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.label, active && styles.labelActive]}>{label}</Text>
    </Pressable>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    chip: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderRadius: radius.pill,
      backgroundColor: colors.surface2,
    },
    chipActive: { backgroundColor: colors.accent },
    label: { fontSize: 13, fontWeight: '600', color: colors.muted },
    labelActive: { color: colors.accentFg },
  });
}
