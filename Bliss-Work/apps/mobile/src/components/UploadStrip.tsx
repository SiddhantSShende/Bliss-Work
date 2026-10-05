import { useMemo } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AlertCircle, RefreshCw, X } from 'lucide-react-native';
import { prettySize } from '@taskboard/app/chatEnvelope';
import { spacing, type ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';
import type { UploadItem } from '../hooks/useChatAttachments';

interface UploadStripProps {
  uploads: UploadItem[];
  onRetry: (key: string) => void;
  onDismiss: (key: string) => void;
}

/**
 * Inline status for files on their way out, rendered just above the composer:
 * "Uploading name… 42%", "Sending name…", or a failed row with the reason and
 * Retry / dismiss. Rows disappear only when the file was uploaded AND the
 * message send succeeded (see useChatAttachments), so what the strip shows is
 * never more optimistic than what actually happened.
 */
export function UploadStrip({ uploads, onRetry, onDismiss }: UploadStripProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  if (uploads.length === 0) return null;

  return (
    <View style={styles.wrap} accessibilityLiveRegion="polite">
      <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
        {uploads.map((u) => (
          <View key={u.key} style={styles.row}>
            {u.status === 'failed' ? (
              <AlertCircle size={16} color={colors.danger} />
            ) : (
              <ActivityIndicator size="small" color={colors.accent} />
            )}
            <View style={styles.textWrap}>
              <Text style={styles.name} numberOfLines={1}>
                {u.status === 'uploading'
                  ? `Uploading ${u.name}… ${Math.round(u.ratio * 100)}%`
                  : u.status === 'sending'
                    ? `Sending ${u.name}…`
                    : u.name}
              </Text>
              {u.status === 'failed' ? (
                <Text style={styles.error} numberOfLines={3}>
                  {u.error ?? 'Upload failed.'}
                </Text>
              ) : u.size ? (
                <Text style={styles.meta}>{prettySize(u.size)}</Text>
              ) : null}
            </View>
            {u.status === 'failed' ? (
              <>
                <Pressable onPress={() => onRetry(u.key)} hitSlop={8} style={styles.action} accessibilityRole="button" accessibilityLabel={`Retry ${u.name}`}>
                  <RefreshCw size={14} color={colors.accent} />
                  <Text style={styles.retry}>Retry</Text>
                </Pressable>
                <Pressable onPress={() => onDismiss(u.key)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Dismiss ${u.name}`}>
                  <X size={16} color={colors.muted} />
                </Pressable>
              </>
            ) : null}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    wrap: {
      backgroundColor: colors.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
    },
    scroll: { maxHeight: 148 },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 6 },
    textWrap: { flex: 1 },
    name: { fontSize: 13, fontWeight: '600', color: colors.fg },
    meta: { fontSize: 11, color: colors.muted, marginTop: 1 },
    error: { fontSize: 12, color: colors.danger, marginTop: 1 },
    action: { flexDirection: 'row', alignItems: 'center', gap: 4, marginRight: spacing.xs },
    retry: { fontSize: 13, fontWeight: '600', color: colors.accent },
  });
}
