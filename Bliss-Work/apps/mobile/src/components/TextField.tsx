import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { colors, spacing } from '../constants/theme';

interface TextFieldProps extends TextInputProps {
  /** Omitted when this field is grouped under another visible label (e.g.
   *  CaptchaField's answer input, under its own "Security check" heading). */
  label?: string;
}

/** One labeled input, styled to match the web app's Field/Input pairing
 *  (rounded-lg bordered field, muted label above it). */
export function TextField({ label, style, ...inputProps }: TextFieldProps) {
  return (
    <View style={styles.container}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={colors.muted}
        style={[styles.input, style]}
        {...inputProps}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.xs,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.muted,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.fg,
    backgroundColor: colors.surface,
  },
});
