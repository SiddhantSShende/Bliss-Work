import { useMemo } from 'react';
import { Check } from 'lucide-react-native';
import { Pressable, StyleSheet } from 'react-native';
import type { ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';

interface CheckboxProps {
  checked: boolean;
  onPress: () => void;
}

/** Selection checkbox for the New Chat people picker's multi-select rows. */
export function Checkbox({ checked, onPress }: CheckboxProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <Pressable onPress={onPress} hitSlop={8} style={[styles.box, checked && styles.boxChecked]}>
      {checked ? <Check size={14} color={colors.accentFg} /> : null}
    </Pressable>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    box: {
      width: 22,
      height: 22,
      borderRadius: 6,
      borderWidth: 2,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    boxChecked: {
      backgroundColor: colors.accent,
      borderColor: colors.accent,
    },
  });
}
