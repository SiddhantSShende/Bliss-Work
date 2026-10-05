import { useMemo } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { GlassCard } from './MeetingsGlass';
import { spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';
import { addDays, dayKey, monthGridStart, sameDay, weekStart } from '../../lib/meetings';

interface MeetingsCalendarProps {
  selected: Date;
  onSelect: (d: Date) => void;
  /** Prev/next month. The selected day moves with it (clamped). */
  onMonthChange: (delta: -1 | 1) => void;
  /** `dayKey()`s of days that have a meeting — they get a dot. */
  meetingDays: ReadonlySet<string>;
  expanded: boolean;
  onToggleExpanded: () => void;
}

// 2024-01-07 was a Sunday; derives localised short weekday names, Sunday first.
const WEEKDAYS = Array.from({ length: 7 }, (_, i) =>
  new Date(2024, 0, 7 + i).toLocaleDateString(undefined, { weekday: 'short' }),
);

/** Compact week strip (like the reference) that expands to a full month grid.
 *  The chevrons always page by month. */
export function MeetingsCalendar({
  selected,
  onSelect,
  onMonthChange,
  meetingDays,
  expanded,
  onToggleExpanded,
}: MeetingsCalendarProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const today = new Date();

  const weeks = useMemo(() => {
    const first = expanded ? monthGridStart(selected) : weekStart(selected);
    const count = expanded ? 6 : 1;
    return Array.from({ length: count }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(first, w * 7 + d)));
  }, [expanded, selected]);

  const title = selected.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <GlassCard style={styles.card}>
      <View style={styles.inner}>
        <View style={styles.monthRow}>
          <Pressable
            onPress={() => onMonthChange(-1)}
            hitSlop={10}
            style={styles.chevron}
            accessibilityRole="button"
            accessibilityLabel="Previous month"
          >
            <ChevronLeft size={20} color={colors.fg} />
          </Pressable>
          <Text style={styles.monthTitle} numberOfLines={1}>
            {title}
          </Text>
          <Pressable
            onPress={() => onMonthChange(1)}
            hitSlop={10}
            style={styles.chevron}
            accessibilityRole="button"
            accessibilityLabel="Next month"
          >
            <ChevronRight size={20} color={colors.fg} />
          </Pressable>
        </View>

        <View style={styles.weekRow}>
          {WEEKDAYS.map((w, i) => (
            <Text key={i} style={styles.weekday} numberOfLines={1}>
              {w}
            </Text>
          ))}
        </View>

        {weeks.map((week, wi) => (
          <View key={wi} style={styles.weekRow}>
            {week.map((d) => {
              const isSelected = sameDay(d, selected);
              const isToday = sameDay(d, today);
              const inMonth = d.getMonth() === selected.getMonth();
              const hasMeeting = meetingDays.has(dayKey(d));
              return (
                <Pressable
                  key={d.toISOString()}
                  onPress={() => onSelect(d)}
                  style={styles.cell}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isSelected }}
                  accessibilityLabel={d.toDateString() + (hasMeeting ? ', has meetings' : '')}
                >
                  <View style={[styles.dayCircle, isToday && styles.dayCircleToday, isSelected && styles.dayCircleSelected]}>
                    <Text
                      style={[
                        styles.dayText,
                        !inMonth && styles.dayTextOut,
                        isToday && styles.dayTextToday,
                        isSelected && styles.dayTextSelected,
                      ]}
                    >
                      {d.getDate()}
                    </Text>
                  </View>
                  <View style={[styles.dot, hasMeeting && styles.dotOn]} />
                </Pressable>
              );
            })}
          </View>
        ))}

        <Pressable
          onPress={onToggleExpanded}
          hitSlop={8}
          style={styles.expand}
          accessibilityRole="button"
          accessibilityLabel={expanded ? 'Show week only' : 'Show full month'}
        >
          {expanded ? <ChevronUp size={18} color={colors.muted} /> : <ChevronDown size={18} color={colors.muted} />}
        </Pressable>
      </View>
    </GlassCard>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    card: { borderRadius: 22 },
    inner: { paddingHorizontal: spacing.md, paddingTop: spacing.md, paddingBottom: spacing.xs },
    monthRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md },
    chevron: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
    monthTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700', color: colors.fg },
    weekRow: { flexDirection: 'row' },
    weekday: { flex: 1, textAlign: 'center', fontSize: 12, fontWeight: '500', color: colors.muted, marginBottom: 6 },
    cell: { flex: 1, alignItems: 'center', paddingVertical: 2 },
    dayCircle: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
    dayCircleToday: { borderWidth: 1.5, borderColor: colors.accent },
    dayCircleSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
    dayText: { fontSize: 15, fontWeight: '600', color: colors.fg },
    dayTextOut: { opacity: 0.35 },
    dayTextToday: { color: colors.accent },
    dayTextSelected: { color: colors.accentFg },
    dot: { width: 5, height: 5, borderRadius: 2.5, marginTop: 3, backgroundColor: 'transparent' },
    dotOn: { backgroundColor: colors.accent },
    expand: { alignSelf: 'center', paddingVertical: 2, paddingHorizontal: spacing.xl },
  });
}
