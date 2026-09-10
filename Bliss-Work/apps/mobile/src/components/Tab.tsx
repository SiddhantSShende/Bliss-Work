import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { radius, spacing, type ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';

export interface TabSpec<T extends string> {
  key: T;
  label: string;
}

interface TabsProps<T extends string> {
  tabs: readonly TabSpec<T>[];
  active: T;
  onChange: (key: T) => void;
  /** Horizontally scrollable strip (Activity's 5 filters) instead of an
   *  evenly-spaced row (Chats' fixed 3 tabs) — set when the tab count can
   *  exceed what comfortably fits one screen width. */
  scrollable?: boolean;
}

/**
 * The underline tab row pattern every screen (Chats, Tasks, MyActivity) was
 * hand-rolling separately — one shared primitive instead of N near-identical
 * copies, per the app's design-consistency goal. Existing screens are
 * unchanged for now (Phase 1 is foundations only); new tab rows (the
 * workspace switcher, the theme picker) are built on this one.
 */
export function Tabs<T extends string>({ tabs, active, onChange, scrollable }: TabsProps<T>) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const row = (
    <View style={[styles.row, scrollable && styles.rowScrollable]}>
      {tabs.map((t) => (
        <Pressable key={t.key} onPress={() => onChange(t.key)} style={styles.tab}>
          <Text style={[styles.label, active === t.key && styles.labelActive]}>{t.label}</Text>
          {active === t.key ? <View style={styles.underline} /> : null}
        </Pressable>
      ))}
    </View>
  );

  if (!scrollable) return row;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      {row}
    </ScrollView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      gap: spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    rowScrollable: { paddingHorizontal: spacing.lg },
    tab: { paddingBottom: spacing.sm },
    label: { fontSize: 14, fontWeight: '600', color: colors.muted },
    labelActive: { color: colors.accent },
    underline: { height: 2, backgroundColor: colors.accent, borderRadius: radius.pill, marginTop: spacing.xs },
  });
}
