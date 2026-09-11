import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ReactionDTO } from '@taskboard/shared';
import { radius, spacing, type ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';

interface ReactionBarProps {
  reactions: ReactionDTO[];
  /** Tapping a pill toggles the caller's own reaction on that emoji — adds
   *  it if `mine` is currently false, removes it if true. */
  onToggle: (emoji: string, on: boolean) => void;
  mine: boolean;
  disabled?: boolean;
}

/** Reaction pills under a message bubble — one per emoji already reacted
 *  with, count shown only above 1 (mirrors web's `ReactionChips` in
 *  packages/app/src/features/MessageActions.tsx), highlighted when the
 *  caller is one of the reactors. Renders nothing when there are none, so an
 *  un-reacted message looks exactly as it always has. */
export function ReactionBar({ reactions, onToggle, mine, disabled }: ReactionBarProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  if (reactions.length === 0) return null;

  return (
    <View style={[styles.row, mine && styles.rowMine]}>
      {reactions.map((r) => (
        <Pressable
          key={r.emoji}
          disabled={disabled}
          onPress={() => onToggle(r.emoji, !r.mine)}
          style={[styles.pill, r.mine && styles.pillMine]}
        >
          <Text style={styles.emoji}>{r.emoji}</Text>
          {r.count > 1 ? <Text style={[styles.count, r.mine && styles.countMine]}>{r.count}</Text> : null}
        </Pressable>
      ))}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
      paddingHorizontal: spacing.md,
      marginTop: -2,
      marginBottom: 4,
    },
    rowMine: { justifyContent: 'flex-end' },
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: spacing.sm,
      paddingVertical: 3,
      borderRadius: radius.pill,
      backgroundColor: colors.surface2,
      borderWidth: 1,
      borderColor: colors.border,
    },
    pillMine: {
      backgroundColor: colors.accentSoft,
      borderColor: colors.accent,
    },
    emoji: { fontSize: 13 },
    count: { fontSize: 11, fontWeight: '600', color: colors.muted },
    countMine: { color: colors.accent },
  });
}
