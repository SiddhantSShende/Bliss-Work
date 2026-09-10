import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { radius, spacing, type ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';

// A fixed quick-pick set rather than a full emoji library: no RN-compatible
// emoji picker is installed in this app (packages/app's emoji-picker-react is
// React-DOM only), and pulling one in is a dependency decision beyond this
// redesign's scope. This covers the common reactions without faking a fuller
// picker than what's actually wired up.
const QUICK_EMOJIS = [
  '😀', '😂', '😍', '👍', '🙏', '🎉', '😢', '😮', '❤️', '🔥',
  '👏', '🙌', '😅', '🤔', '😎', '💯', '✅', '👀', '🚀', '😴',
];

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
}

/** Inline horizontal strip of common emoji, opened above the composer. */
export function EmojiPicker({ onSelect }: EmojiPickerProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.container}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {QUICK_EMOJIS.map((emoji) => (
          <Pressable key={emoji} onPress={() => onSelect(emoji)} style={styles.item}>
            <Text style={styles.emoji}>{emoji}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: {
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: colors.surface,
    },
    row: {
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
      gap: spacing.xs,
    },
    item: {
      width: 40,
      height: 40,
      borderRadius: radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    emoji: {
      fontSize: 22,
    },
  });
}
