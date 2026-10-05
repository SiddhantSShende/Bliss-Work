import { useMemo, type ReactNode } from 'react';
import { ArrowLeft, Check, SendHorizontal, X } from 'lucide-react-native';
import { ActivityIndicator, KeyboardAvoidingView, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { radius, spacing, type ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';

/** Full-screen frame of every quick-action flow: back arrow, title, content. No tab bar. */
export function QuickFrame({ title, onBack, children }: { title: string; onBack: () => void; children: ReactNode }) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView style={[styles.frame, { paddingTop: insets.top }]} behavior="padding">
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={10} accessibilityRole="button" accessibilityLabel="Back">
          <ArrowLeft size={22} color={colors.fg} />
        </Pressable>
        <Text style={styles.title}>{title}</Text>
      </View>
      {children}
    </KeyboardAvoidingView>
  );
}

/** Single-select marker (radio). */
export function RadioDot({ selected }: { selected: boolean }) {
  const colors = useThemeColors();
  return (
    <View
      style={{
        width: 24,
        height: 24,
        borderRadius: 12,
        borderWidth: 2,
        borderColor: selected ? colors.accent : colors.border,
        backgroundColor: selected ? colors.accent : 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {selected ? <Check size={14} color={colors.accentFg} /> : null}
    </View>
  );
}

interface ComposerProps {
  /** "To:" chip label (a member name, or a channel name). */
  chipLabel: string | null;
  chipPrefix: string;
  onClearChip: () => void;
  value: string;
  onChangeText: (t: string) => void;
  onSend: () => void;
  sending: boolean;
  error: string | null;
  placeholder: string;
  /** Shown while no recipient is chosen yet. */
  emptyPlaceholder?: string;
}

/** Bottom composer shared by Quick Chat and Quick Channel: recipient chip + input + send. */
export function QuickComposer({ chipLabel, chipPrefix, onClearChip, value, onChangeText, onSend, sending, error, placeholder, emptyPlaceholder = 'Pick a recipient first' }: ComposerProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const canSend = !!chipLabel && value.trim().length > 0 && !sending;
  return (
    <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <View style={styles.inputRow}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={chipLabel ? placeholder : emptyPlaceholder}
          placeholderTextColor={colors.muted}
          style={styles.input}
          multiline
          editable={!sending}
          accessibilityLabel="Message"
        />
        <Pressable onPress={onSend} disabled={!canSend} style={[styles.send, !canSend && styles.sendDisabled]} accessibilityRole="button" accessibilityLabel="Send">
          {sending ? <ActivityIndicator size="small" color={colors.accentFg} /> : <SendHorizontal size={18} color={colors.accentFg} />}
        </Pressable>
      </View>
      <View style={styles.toRow}>
        <Text style={styles.toLabel}>To:</Text>
        {chipLabel ? (
          <Pressable onPress={onClearChip} style={styles.chip} accessibilityLabel={`Remove ${chipLabel}`}>
            <Text style={styles.chipText} numberOfLines={1}>
              {chipPrefix}
              {chipLabel}
            </Text>
            <X size={13} color={colors.accent} />
          </Pressable>
        ) : (
          <Text style={styles.toHint}>nobody selected</Text>
        )}
      </View>
    </View>
  );
}

/**
 * The success state, on the glass sheet: shown only after the backend confirmed
 * the action. "Done" returns to the launcher (or the app), "Another" resets the form.
 */
export function QuickDone({ visible, message, anotherLabel, onDone, onAnother }: { visible: boolean; message: string; anotherLabel: string; onDone: () => void; onAnother: () => void }) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <Modal visible={visible} onClose={onDone} variant="center" title="Done">
      <View style={styles.doneWrap}>
        <View style={styles.doneIcon}>
          <Check size={28} color={colors.accentFg} />
        </View>
        <Text style={styles.doneText}>{message}</Text>
        <View style={styles.doneActions}>
          <Button title={anotherLabel} variant="ghost" onPress={onAnother} style={styles.half} />
          <Button title="Done" onPress={onDone} style={styles.half} />
        </View>
      </View>
    </Modal>
  );
}

export function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    frame: { flex: 1, backgroundColor: colors.bg },
    header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
    title: { fontSize: 18, fontWeight: '700', color: colors.fg },
    composer: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, gap: spacing.xs, backgroundColor: colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
    input: { flex: 1, maxHeight: 120, backgroundColor: colors.surface2, borderRadius: radius.card, paddingHorizontal: spacing.md, paddingVertical: 10, fontSize: 15, color: colors.fg },
    send: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
    sendDisabled: { opacity: 0.4 },
    toRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 30 },
    toLabel: { fontSize: 13, color: colors.muted },
    toHint: { fontSize: 13, color: colors.muted },
    chip: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, maxWidth: 240, paddingHorizontal: spacing.sm, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: colors.accentSoft },
    chipText: { fontSize: 13, fontWeight: '600', color: colors.fg, flexShrink: 1 },
    error: { fontSize: 13, color: colors.danger },
    doneWrap: { alignItems: 'center', gap: spacing.md, paddingBottom: spacing.sm },
    doneIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: colors.success, alignItems: 'center', justifyContent: 'center' },
    doneText: { fontSize: 15, fontWeight: '600', color: colors.fg, textAlign: 'center' },
    doneActions: { flexDirection: 'row', gap: spacing.sm, alignSelf: 'stretch' },
    half: { flex: 1 },
  });
}
