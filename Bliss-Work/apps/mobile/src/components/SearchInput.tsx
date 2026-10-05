import { useMemo, useState } from 'react';
import { Search } from 'lucide-react-native';
import { StyleSheet, TextInput, View } from 'react-native';
import { radius, spacing, type ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';

interface SearchInputProps {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  autoFocus?: boolean;
}

/** Rounded pill search field with a leading icon — used by Chats, New Chat,
 *  and Members search, all needing the exact same look. */
export function SearchInput({ value, onChangeText, placeholder, autoFocus }: SearchInputProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [focused, setFocused] = useState(false);
  return (
    <View style={[styles.container, focused && styles.containerFocused]}>
      <Search size={18} color={colors.muted} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={autoFocus}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        returnKeyType="search"
        accessibilityLabel={placeholder}
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
      backgroundColor: colors.input,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      height: 42,
    },
    containerFocused: { borderColor: colors.accent },
    input: {
      flex: 1,
      fontSize: 15,
      color: colors.fg,
      padding: 0,
    },
  });
}
