import { useMemo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { radius, shadows, type ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';

interface CardProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Pressable rows (list items) sit flush against the screen edge and don't
   *  want the card's own padding — they apply their own per-row. */
  noPadding?: boolean;
}

/** The one rounded white surface every section/list/summary card in the
 *  redesign sits on — `radius.card` + `shadows.card` + `colors.surface`,
 *  matching the reference's card language. */
export function Card({ children, style, noPadding }: CardProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return <View style={[styles.card, !noPadding && styles.padding, style]}>{children}</View>;
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderRadius: radius.card,
      borderWidth: 1,
      borderColor: colors.border,
      ...shadows.soft,
    },
    padding: {
      padding: 16,
    },
  });
}
