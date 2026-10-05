import { useMemo, useState } from 'react';
import { X } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { isValidMailAddress } from '@taskboard/shared';
import { useDirectory } from '../../hooks/useDirectory';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';

interface Props {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  autoFocus?: boolean;
}

/**
 * A To/Cc/Bcc line: typed addresses become removable chips (on comma, space,
 * Enter or blur), with org-directory suggestions underneath — the same
 * `api.directory()` the rest of the app already uses. An address that is not a
 * valid mail address shows in the danger colour, and the composer will not send
 * with one (same `isValidMailAddress` the server-side rules mirror).
 */
export function MailAddressField({ label, value, onChange, autoFocus }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [text, setText] = useState('');
  const { filtered } = useDirectory(text.trim());

  const has = (a: string) => value.some((v) => v.toLowerCase() === a.toLowerCase());

  const commit = (raw: string) => {
    const parts = raw
      .split(/[\s,;]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (!parts.length) return;
    const next = [...value];
    for (const p of parts) if (!next.some((v) => v.toLowerCase() === p.toLowerCase())) next.push(p);
    onChange(next);
    setText('');
  };

  const suggestions = text.trim().length > 0 ? filtered.filter((u) => !has(u.email)).slice(0, 4) : [];

  return (
    <View>
      <View style={styles.row}>
        <Text style={styles.label}>{label}</Text>
        <View style={styles.chips}>
          {value.map((a) => {
            const ok = isValidMailAddress(a);
            return (
              <View key={a} style={[styles.chip, !ok && styles.chipBad]}>
                <Text style={[styles.chipText, !ok && styles.chipTextBad]} numberOfLines={1}>
                  {a}
                </Text>
                <Pressable
                  hitSlop={8}
                  onPress={() => onChange(value.filter((v) => v !== a))}
                  accessibilityLabel={`Remove ${a}`}
                >
                  <X size={13} color={ok ? colors.muted : colors.danger} />
                </Pressable>
              </View>
            );
          })}
          <TextInput
            value={text}
            onChangeText={(t) => (/[\s,;]$/.test(t) ? commit(t) : setText(t))}
            onSubmitEditing={() => commit(text)}
            onBlur={() => commit(text)}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            autoFocus={autoFocus}
            placeholder={value.length ? '' : 'name@company.com'}
            placeholderTextColor={colors.muted}
            blurOnSubmit={false}
            accessibilityLabel={label}
          />
        </View>
      </View>
      {suggestions.length > 0 ? (
        <View style={styles.suggestions}>
          {suggestions.map((u) => (
            <Pressable key={u.id} style={styles.suggestion} onPress={() => commit(u.email)}>
              <Text style={styles.suggestionName} numberOfLines={1}>
                {u.displayName}
              </Text>
              <Text style={styles.suggestionEmail} numberOfLines={1}>
                {u.email}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.md,
      paddingVertical: spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    label: { width: 34, fontSize: 14, color: colors.muted, paddingTop: 8 },
    chips: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, alignItems: 'center' },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      maxWidth: '100%',
      paddingHorizontal: spacing.sm,
      paddingVertical: 4,
      borderRadius: radius.pill,
      backgroundColor: colors.accentSoft,
    },
    chipBad: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.danger },
    chipText: { fontSize: 13, color: colors.fg, flexShrink: 1 },
    chipTextBad: { color: colors.danger },
    input: { flexGrow: 1, minWidth: 120, fontSize: 15, color: colors.fg, paddingVertical: 6 },
    suggestions: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: radius.card,
      backgroundColor: colors.surface,
      marginVertical: spacing.xs,
      overflow: 'hidden',
    },
    suggestion: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
    suggestionName: { fontSize: 14, fontWeight: '600', color: colors.fg },
    suggestionEmail: { fontSize: 12, color: colors.muted },
  });
}
