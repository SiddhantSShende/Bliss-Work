import { useMemo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { spacing, type ThemeColors } from '../../../constants/theme';
import { useThemeColors } from '../../../theme/ThemeProvider';

/** Footer under a paged list: spinner while fetching, a "Load older" button
 *  while another page exists (the FlatList also auto-loads near the end), and
 *  an optional closing note once paging runs out. */
export function LoadMoreFooter({
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  endNote,
}: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  endNote?: string;
}) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  if (isFetchingNextPage) return <ActivityIndicator color={colors.accent} style={{ marginVertical: spacing.md }} />;
  if (hasNextPage) {
    return (
      <Pressable onPress={onLoadMore} style={styles.btn} accessibilityRole="button">
        <Text style={styles.btnText}>Load older</Text>
      </Pressable>
    );
  }
  return endNote ? (
    <View style={styles.note}>
      <Text style={styles.noteText}>{endNote}</Text>
    </View>
  ) : null;
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    btn: { alignSelf: 'center', paddingVertical: spacing.sm, paddingHorizontal: spacing.lg },
    btnText: { fontSize: 13, fontWeight: '600', color: colors.accent },
    note: { paddingVertical: spacing.md },
    noteText: { fontSize: 12, color: colors.muted, textAlign: 'center' },
  });
}
