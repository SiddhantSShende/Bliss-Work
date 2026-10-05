import { useMemo, useRef, useState } from 'react';
import { PanResponder, Pressable, StyleSheet, Text, View, useWindowDimensions, type GestureResponderEvent } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';
import { Modal } from '../Modal';
import { angleToHour, angleToMinute, hourToAngle, minuteToAngle, pointToAngle, polar } from '../../lib/clockPicker';
import type { Clock12 } from '../../lib/meetingSchedule';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';

interface Props {
  visible: boolean;
  /** The time the dial opens on. */
  value: Clock12;
  onCancel: () => void;
  onConfirm: (c: Clock12) => void;
}

type Mode = 'hour' | 'minute';

const pad = (n: number) => String(n).padStart(2, '0');
const HOURS = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const MINUTE_LABELS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
const NUMBER_BOX = 40; // tap/label box around each number
const HAND_END = 20; // the hand stops at the edge of the selection circle

/**
 * Clock-face time picker: pick the hour on the dial (it then moves on to the
 * minutes), flip AM/PM in the header, Cancel / OK. The dial is a real control —
 * a touch or drag turns into an hour or minute through `lib/clockPicker.ts`'s
 * angle maths — and the result is the same `Clock12` the rest of the New Meeting
 * form already uses, so nothing downstream changes.
 */
export function ClockTimePicker({ visible, value, onCancel, onConfirm }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { width } = useWindowDimensions();
  // Responsive: the dial never exceeds the dialog's usable width on a small phone.
  const size = Math.max(200, Math.min(280, width - 96));
  const center = size / 2;
  const ring = center - NUMBER_BOX / 2 - 2;

  const [draft, setDraft] = useState<Clock12>(value);
  const [mode, setMode] = useState<Mode>('hour');
  // Re-open on the field's current value, on the hour dial (React's "adjust state on prop change").
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) {
      setDraft(value);
      setMode('hour');
    }
  }

  // The PanResponder is created once, so it reads the current mode/size through a ref.
  const live = useRef({ mode, center });
  live.current = { mode, center };

  const apply = (e: GestureResponderEvent) => {
    const { locationX, locationY } = e.nativeEvent;
    const { mode: m, center: c } = live.current;
    const angle = pointToAngle(locationX - c, locationY - c);
    if (m === 'hour') setDraft((d) => ({ ...d, hour: angleToHour(angle) }));
    else setDraft((d) => ({ ...d, minute: angleToMinute(angle) }));
  };
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: apply,
      onPanResponderMove: apply,
      // Lifting the finger off the hour dial moves on to the minutes, as the system picker does.
      onPanResponderRelease: () => {
        if (live.current.mode === 'hour') setMode('minute');
      },
    }),
  ).current;

  const selectedAngle = mode === 'hour' ? hourToAngle(draft.hour) : minuteToAngle(draft.minute);
  const tip = polar(selectedAngle, ring - HAND_END);
  const knob = polar(selectedAngle, ring);
  const labels = mode === 'hour' ? HOURS : MINUTE_LABELS;
  const isSelectedLabel = (n: number) => (mode === 'hour' ? n === draft.hour : n === draft.minute);

  return (
    <Modal visible={visible} onClose={onCancel} variant="center" backdropOpacity={0.82} panelTintOpacity={0.97}>
      <View style={styles.header}>
        <View style={styles.time}>
          <Pressable
            onPress={() => setMode('hour')}
            style={[styles.segment, mode === 'hour' && styles.segmentActive]}
            accessibilityRole="button"
            accessibilityLabel={`Hour ${draft.hour}`}
            accessibilityState={{ selected: mode === 'hour' }}
          >
            <Text style={[styles.segmentText, mode === 'hour' && styles.segmentTextActive]}>{draft.hour}</Text>
          </Pressable>
          <Text style={styles.colon}>:</Text>
          <Pressable
            onPress={() => setMode('minute')}
            style={[styles.segment, mode === 'minute' && styles.segmentActive]}
            accessibilityRole="button"
            accessibilityLabel={`Minute ${pad(draft.minute)}`}
            accessibilityState={{ selected: mode === 'minute' }}
          >
            <Text style={[styles.segmentText, mode === 'minute' && styles.segmentTextActive]}>{pad(draft.minute)}</Text>
          </Pressable>
        </View>
        <View style={styles.ampm}>
          {[false, true].map((pm) => (
            <Pressable
              key={String(pm)}
              onPress={() => setDraft((d) => ({ ...d, pm }))}
              style={[styles.ampmBtn, !pm && styles.ampmTop, draft.pm === pm && styles.ampmActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: draft.pm === pm }}
            >
              <Text style={[styles.ampmText, draft.pm === pm && styles.ampmTextActive]}>{pm ? 'PM' : 'AM'}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={[styles.dial, { width: size, height: size, borderRadius: center }]} {...pan.panHandlers}>
        <Svg width={size} height={size} pointerEvents="none">
          <Line x1={center} y1={center} x2={center + tip.x} y2={center + tip.y} stroke={colors.accent} strokeWidth={2} />
          <Circle cx={center + knob.x} cy={center + knob.y} r={NUMBER_BOX / 2} fill={colors.accent} />
          {/* A minute that is not on a 5-minute label is shown by the knob sitting between numbers. */}
          <Circle cx={center} cy={center} r={4} fill={colors.accent} />
        </Svg>
        {labels.map((n) => {
          const p = polar(mode === 'hour' ? hourToAngle(n) : minuteToAngle(n), ring);
          return (
            <View
              key={n}
              pointerEvents="none"
              style={[styles.numberBox, { left: center + p.x - NUMBER_BOX / 2, top: center + p.y - NUMBER_BOX / 2 }]}
            >
              <Text style={[styles.number, isSelectedLabel(n) && styles.numberSelected]}>{mode === 'hour' ? n : pad(n)}</Text>
            </View>
          );
        })}
      </View>

      <View style={styles.actions}>
        <Pressable onPress={onCancel} style={styles.cancel} accessibilityRole="button">
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
        <Pressable onPress={() => onConfirm(draft)} style={styles.ok} accessibilityRole="button">
          <Text style={styles.okText}>OK</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.md, marginBottom: spacing.lg },
    time: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    segment: { minWidth: 64, alignItems: 'center', paddingVertical: spacing.sm, paddingHorizontal: spacing.md, borderRadius: radius.card },
    segmentActive: { backgroundColor: colors.accentSoft },
    segmentText: { fontSize: 38, fontWeight: '500', color: colors.fg },
    segmentTextActive: { color: colors.accent },
    colon: { fontSize: 34, fontWeight: '700', color: colors.muted },
    ampm: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.card, overflow: 'hidden' },
    ampmBtn: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, alignItems: 'center', backgroundColor: 'transparent' },
    ampmTop: { borderBottomWidth: 1, borderBottomColor: colors.border },
    ampmActive: { backgroundColor: colors.accent },
    ampmText: { fontSize: 13, fontWeight: '700', color: colors.muted },
    ampmTextActive: { color: colors.accentFg },
    dial: { alignSelf: 'center', backgroundColor: colors.surface2 },
    numberBox: { position: 'absolute', width: NUMBER_BOX, height: NUMBER_BOX, alignItems: 'center', justifyContent: 'center' },
    number: { fontSize: 15, fontWeight: '600', color: colors.fg },
    numberSelected: { color: colors.accentFg },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: spacing.sm, marginTop: spacing.lg },
    cancel: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
    cancelText: { fontSize: 15, fontWeight: '600', color: colors.muted },
    ok: { paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: radius.card, backgroundColor: colors.accent },
    okText: { fontSize: 15, fontWeight: '700', color: colors.accentFg },
  });
}
