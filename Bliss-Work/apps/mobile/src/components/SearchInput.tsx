import { useMemo } from 'react';
import { Search } from 'lucide-react-native';
import { StyleSheet, TextInput, View } from 'react-native';
import { radius, spacing, type ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';

interface SearchInputProps {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
}

/** Rounded pill search field with a leading icon — used by Chats, New Chat,
 *  and Members search, all needing the exact same look. */
export function SearchInput({ value, onChangeText, placeholder }: SearchInputProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.container}>
      <Search size={18} color={colors.muted} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      backgroundColor: colors.surface2,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      height: 42,
    },
    input: {
      flex: 1,
      fontSize: 15,
      color: colors.fg,
      padding: 0,
    },
  });
}
