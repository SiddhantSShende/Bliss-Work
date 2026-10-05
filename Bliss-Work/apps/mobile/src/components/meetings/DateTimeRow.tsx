import { useMemo, useState } from 'react';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Clock } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Modal } from '../Modal';
import { ClockTimePicker } from './ClockTimePicker';
import { addDays, addMonths, monthGridStart, sameDay } from '../../lib/meetings';
import {
  formatDateField,
  formatTimeField,
  toClock12,
  withCalendarDay,
  withClock12,
} from '../../lib/meetingSchedule';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';

interface Props {
  label: string;
  value: Date;
  onChange: (next: Date) => void;
  error?: string;
  /** Days before this one are not selectable in the calendar. */
  minDate?: Date;
}

/** Below this width the date and time fields stack instead of squeezing side by side. */
const STACK_BELOW = 340;

/**
 * One "Start Time" / "End Time" field: a date button and a time button, as in
 * the reference New Meeting design. Each opens its own picker; the value is a
 * real `Date` throughout, so what is shown ("03:16 PM") and what is compared
 * and sent are the same instant.
 */
export function DateTimeRow({ label, value, onChange, error, minDate }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [open, setOpen] = useState<'date' | 'time' | null>(null);
  // The row lives inside a padded card, so judge the room by the window minus its padding.
  const stacked = useWindowDimensions().width - spacing.lg * 4 < STACK_BELOW;

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <View style={[styles.row, stacked && styles.rowStacked]}>
        <Pressable
          onPress={() => setOpen('date')}
          style={({ pressed }) => [styles.field, styles.date, error ? styles.fieldError : null, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={`${label} date, ${formatDateField(value)}`}
        >
          <CalendarDays size={16} color={colors.accent} />
          <Text style={styles.fieldText}>{formatDateField(value)}</Text>
        </Pressable>
        <Pressable
          onPress={() => setOpen('time')}
          style={({ pressed }) => [styles.field, styles.time, error ? styles.fieldError : null, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={`${label} time, ${formatTimeField(value)}`}
        >
          <Clock size={16} color={colors.accent} />
          <Text style={styles.fieldText}>{formatTimeField(value)}</Text>
          <ChevronDown size={16} color={colors.muted} />
        </Pressable>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <CalendarSheet
        visible={open === 'date'}
        value={value}
        title={`${label} date`}
        minDate={minDate}
        onClose={() => setOpen(null)}
        onPick={(y, m, d) => {
          onChange(withCalendarDay(value, y, m, d));
          setOpen(null);
        }}
      />
      <ClockTimePicker
        visible={open === 'time'}
        value={toClock12(value)}
        onCancel={() => setOpen(null)}
        onConfirm={(c) => {
          onChange(withClock12(value, c));
          setOpen(null);
        }}
      />
    </View>
  );
}

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function CalendarSheet({
  visible,
  value,
  title,
  minDate,
  onClose,
  onPick,
}: {
  visible: boolean;
  value: Date;
  title: string;
  minDate?: Date;
  onClose: () => void;
  onPick: (y: number, m: number, d: number) => void;
}) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [month, setMonth] = useState(() => new Date(value.getFullYear(), value.getMonth(), 1));
  // Reopening shows the month of the current value, not wherever it was left.
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) setMonth(new Date(value.getFullYear(), value.getMonth(), 1));
  }
  const start = monthGridStart(month);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const today = new Date();
  const firstAllowed = minDate ? new Date(minDate.getFullYear(), minDate.getMonth(), minDate.getDate()).getTime() : -Infinity;

  return (
    <Modal visible={visible} onClose={onClose} title={title} variant="center" backdropOpacity={0.82} panelTintOpacity={0.95}>
      <View style={styles.monthRow}>
        <Pressable onPress={() => setMonth(addMonths(month, -1))} hitSlop={10} accessibilityLabel="Previous month">
          <ChevronLeft size={22} color={colors.fg} />
        </Pressable>
        <Text style={styles.monthTitle}>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</Text>
        <Pressable onPress={() => setMonth(addMonths(month, 1))} hitSlop={10} accessibilityLabel="Next month">
          <ChevronRight size={22} color={colors.fg} />
        </Pressable>
      </View>
      <View style={styles.weekRow}>
        {WEEKDAYS.map((d, i) => (
          <Text key={i} style={styles.weekday}>
            {d}
          </Text>
        ))}
      </View>
      <View style={styles.grid}>
        {cells.map((d) => {
          const inMonth = d.getMonth() === month.getMonth();
          const selected = sameDay(d, value);
          const isToday = sameDay(d, today);
          const blocked = d.getTime() < firstAllowed;
          return (
            <Pressable
              key={d.getTime()}
              onPress={() => onPick(d.getFullYear(), d.getMonth(), d.getDate())}
              disabled={blocked}
              style={[styles.cell, selected && styles.cellSelected, !selected && isToday && styles.cellToday]}
              accessibilityRole="button"
              accessibilityLabel={d.toDateString()}
              accessibilityState={{ selected, disabled: blocked }}
            >
              <Text style={[styles.cellText, (!inMonth || blocked) && styles.cellOut, selected && styles.cellTextSelected]}>{d.getDate()}</Text>
            </Pressable>
          );
        })}
      </View>
    </Modal>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    wrap: { gap: spacing.xs },
    label: { fontSize: 14, fontWeight: '600', color: colors.fg },
    row: { flexDirection: 'row', gap: spacing.sm },
    rowStacked: { flexDirection: 'column' },
    pressed: { opacity: 0.7 },
    field: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.card,
      paddingHorizontal: spacing.md,
      minHeight: 50,
      backgroundColor: colors.surface,
    },
    fieldError: { borderColor: colors.danger },
    date: { flex: 1.1, minWidth: 0 },
    time: { flex: 1, minWidth: 0 },
    fieldText: { flex: 1, fontSize: 14, color: colors.fg },
    error: { fontSize: 12, color: colors.danger },
    monthRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm },
    monthTitle: { fontSize: 15, fontWeight: '700', color: colors.fg },
    weekRow: { flexDirection: 'row' },
    weekday: { flex: 1, textAlign: 'center', fontSize: 12, fontWeight: '600', color: colors.muted, paddingVertical: 4 },
    grid: { flexDirection: 'row', flexWrap: 'wrap' },
    cell: { width: `${100 / 7}%`, aspectRatio: 1, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill },
    cellSelected: { backgroundColor: colors.accent },
    cellToday: { borderWidth: 1, borderColor: colors.accent },
    cellText: { fontSize: 14, color: colors.fg },
    cellOut: { color: colors.muted, opacity: 0.5 },
    cellTextSelected: { color: colors.accentFg, fontWeight: '700' },
  });
}
