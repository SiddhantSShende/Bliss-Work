import { useMemo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import { radius, type ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';

interface ButtonProps {
  title: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'ghost';
  style?: StyleProp<ViewStyle>;
}

/** The one button style this app needs so far: solid accent, or a plain
 *  text-only ghost variant for secondary actions (matches the web app's
 *  own primary/link split in AuthLayout forms). */
export function Button({ title, onPress, loading, disabled, variant = 'primary', style }: ButtonProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const isDisabled = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        variant === 'primary' ? styles.primary : styles.ghost,
        isDisabled && styles.disabled,
        pressed && !isDisabled && styles.pressed,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? colors.accentFg : colors.accent} size="small" />
      ) : (
        <Text style={variant === 'primary' ? styles.primaryText : styles.ghostText}>{title}</Text>
      )}
    </Pressable>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    primary: {
      backgroundColor: colors.accent,
      borderRadius: radius.card,
      paddingVertical: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    primaryText: {
      color: colors.accentFg,
      fontSize: 16,
      fontWeight: '600',
    },
    ghost: {
      paddingVertical: 8,
      alignItems: 'center',
      justifyContent: 'center',
    },
    ghostText: {
      color: colors.accent,
      fontSize: 14,
      fontWeight: '600',
    },
    disabled: {
      opacity: 0.5,
    },
    pressed: {
      opacity: 0.85,
    },
  });
}
