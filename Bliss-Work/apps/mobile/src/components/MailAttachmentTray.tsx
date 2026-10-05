import { useMemo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { AlertCircle, Paperclip, RefreshCw, X } from 'lucide-react-native';
import { prettySize } from '@taskboard/app/chatEnvelope';
import type { MailAttachmentItem } from '../hooks/useMailAttachments';
import { radius, spacing, type ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';
import { FileGlyph, fileTypeLabel } from './FileGlyph';

interface Props {
  items: MailAttachmentItem[];
  onAttach: () => void;
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
  /** The draft is not open yet, so there is nothing to attach to. */
  disabled?: boolean;
}

/**
 * "Attach file" button + the list of files on the mail being composed: name,
 * type, size, upload progress, and a remove (✕) per file. Uses the same glass
 * tokens (surface / border) as the rest of the mail screens.
 */
export function MailAttachmentTray({ items, onAttach, onRemove, onRetry, disabled }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={onAttach}
        disabled={disabled}
        style={[styles.attachBtn, disabled && styles.disabled]}
        accessibilityRole="button"
        accessibilityLabel="Attach file"
      >
        <Paperclip size={16} color={colors.accent} />
        <Text style={styles.attachText}>Attach file</Text>
      </Pressable>

      {items.map((a) => (
        <View key={a.key} style={[styles.row, a.status === 'failed' && styles.rowFailed]}>
          <FileGlyph mime={a.mime} name={a.name} uri={a.uri} />
          <View style={styles.textWrap}>
            <Text style={styles.name} numberOfLines={1}>
              {a.name}
            </Text>
            {a.status === 'failed' ? (
              <Text style={styles.error} numberOfLines={3}>
                {a.error ?? 'File upload failed. Please try again.'}
              </Text>
            ) : (
              <Text style={styles.meta} numberOfLines={1}>
                {a.status === 'uploading'
                  ? `Uploading… ${Math.round(a.ratio * 100)}%`
                  : [fileTypeLabel(a.mime, a.name), a.size !== undefined ? prettySize(a.size) : null].filter(Boolean).join(' · ')}
              </Text>
            )}
          </View>
          {a.status === 'uploading' ? <ActivityIndicator size="small" color={colors.accent} /> : null}
          {a.status === 'failed' ? (
            <>
              <AlertCircle size={16} color={colors.danger} />
              <Pressable onPress={() => onRetry(a.key)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Retry ${a.name}`} style={styles.retry}>
                <RefreshCw size={14} color={colors.accent} />
                <Text style={styles.retryText}>Retry</Text>
              </Pressable>
            </>
          ) : null}
          <Pressable onPress={() => onRemove(a.key)} hitSlop={10} accessibilityRole="button" accessibilityLabel={`Remove ${a.name}`}>
            <X size={18} color={colors.muted} />
          </Pressable>
        </View>
      ))}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    wrap: { gap: spacing.sm, paddingTop: spacing.md },
    attachBtn: {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.pill,
      backgroundColor: colors.accentSoft,
    },
    attachText: { fontSize: 13, fontWeight: '600', color: colors.accent },
    disabled: { opacity: 0.45 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      padding: spacing.sm,
      borderRadius: radius.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderHighlight,
      backgroundColor: colors.surface,
    },
    rowFailed: { borderColor: colors.danger },
    textWrap: { flex: 1 },
    name: { fontSize: 14, fontWeight: '600', color: colors.fg },
    meta: { fontSize: 12, color: colors.muted, marginTop: 1 },
    error: { fontSize: 12, color: colors.danger, marginTop: 1 },
    retry: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    retryText: { fontSize: 13, fontWeight: '600', color: colors.accent },
  });
}
