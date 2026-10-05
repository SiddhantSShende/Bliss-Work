import { useMemo, type ReactNode } from 'react';
import { AlertCircle } from 'lucide-react-native';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { errorText } from '@taskboard/app/lib/errorText';
import { radius, spacing, type ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';

/** Server errors arrive as `{"error":"..."}` / `{"message":"..."}` bodies; show just the sentence. */
export function friendlyError(e: unknown): string {
  const raw = errorText(e).trim();
  if (raw.startsWith('{')) {
    try {
      const o = JSON.parse(raw) as { message?: unknown; error?: unknown };
      const msg = typeof o.message === 'string' ? o.message : typeof o.error === 'string' ? o.error : undefined;
      if (msg) return msg.charAt(0).toUpperCase() + msg.slice(1);
    } catch {
      // not JSON after all
    }
  }
  return raw;
}

export function LoadingState({ label = 'Loading...' }: { label?: string }) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.center} accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator color={colors.accent} />
      <Text style={styles.muted}>{label}</Text>
    </View>
  );
}

export function ErrorState({ title, error, onRetry }: { title: string; error?: unknown; onRetry?: () => void }) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.center} accessibilityRole="alert">
      <AlertCircle size={28} color={colors.danger} />
      <Text style={styles.title}>{title}</Text>
      {error ? (
        <Text style={styles.muted} numberOfLines={3}>
          {friendlyError(error)}
        </Text>
      ) : null}
      {onRetry ? (
        <Pressable onPress={onRetry} style={styles.retry} accessibilityRole="button">
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

interface ListEmptyProps {
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  onRetry?: () => void;
  errorTitle: string;
  loadingLabel?: string;
  /** Shown when the request succeeded and the list is genuinely empty. */
  empty: ReactNode;
}

/**
 * The single `ListEmptyComponent` body for a backend-powered list: Loading ->
 * Error (+ Retry) -> Empty. Render it only for the empty-data case; when rows
 * exist the list itself is the success state.
 */
export function ListEmpty({ isLoading, isError, error, onRetry, errorTitle, loadingLabel, empty }: ListEmptyProps) {
  if (isLoading) return <LoadingState label={loadingLabel} />;
  if (isError) return <ErrorState title={errorTitle} error={error} onRetry={onRetry} />;
  return <>{empty}</>;
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    center: { alignItems: 'center', justifyContent: 'center', padding: spacing['2xl'], gap: spacing.sm },
    title: { fontSize: 15, fontWeight: '600', color: colors.fg, textAlign: 'center' },
    muted: { fontSize: 13, color: colors.muted, textAlign: 'center' },
    retry: {
      marginTop: spacing.sm,
      paddingHorizontal: spacing.xl,
      paddingVertical: spacing.sm + 2,
      borderRadius: radius.pill,
      backgroundColor: colors.accent,
    },
    retryText: { color: colors.accentFg, fontSize: 14, fontWeight: '600' },
  });
}
