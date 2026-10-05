import { memo } from 'react';
import type { LucideIcon } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useMeetingSkin } from './skin';

/** One meeting control: round icon button with a label under it. */
interface ControlProps {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  /** Currently switched on / highlighted (e.g. sharing). */
  active?: boolean;
  /** Shown in the "off" state (muted mic, camera off): icon in the danger colour. */
  off?: boolean;
  /** Small count badge (unread chat). */
  badge?: number;
  disabled?: boolean;
  /** Solid red (End). */
  danger?: boolean;
  testID?: string;
}

export const ControlButton = memo(function ControlButton({
  icon: Icon,
  label,
  onPress,
  active,
  off,
  badge,
  disabled,
  danger,
  testID,
}: ControlProps) {
  const skin = useMeetingSkin();
  const tint = danger
    ? '#ffffff'
    : active
    ? skin.accent
    : off
    ? skin.danger
    : skin.ink;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active, disabled: !!disabled }}
      testID={testID}
      hitSlop={4}
      style={({ pressed }) => [
        styles.cell,
        { opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
      ]}
    >
      <View
        style={[
          styles.round,
          {
            backgroundColor: danger
              ? skin.danger
              : active
              ? skin.accentSoft
              : 'rgba(255,255,255,0.09)',
            borderColor: danger
              ? skin.danger
              : active
              ? skin.accent
              : 'rgba(255,255,255,0.14)',
          },
        ]}
      >
        <Icon size={21} color={tint} />
        {badge && badge > 0 ? (
          <View style={[styles.badge, { backgroundColor: skin.accent }]}>
            <Text style={[styles.badgeText, { color: skin.accentInk }]}>
              {badge > 9 ? '9+' : badge}
            </Text>
          </View>
        ) : null}
      </View>
      <Text
        style={[styles.label, { color: active ? skin.accent : skin.muted }]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
});

/** The wide red End / Leave button under the control row. */
export const EndButton = memo(function EndButton({
  label,
  onPress,
  icon: Icon,
  compact,
}: {
  label: string;
  onPress: () => void;
  icon: LucideIcon;
  /** Sits inside the control row (landscape) instead of under it. */
  compact?: boolean;
}) {
  const skin = useMeetingSkin();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.end,
        compact && styles.endCompact,
        { backgroundColor: skin.danger, opacity: pressed ? 0.85 : 1 },
      ]}
    >
      <Icon size={20} color="#ffffff" />
      <Text style={styles.endText}>{label}</Text>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  cell: { flex: 1, alignItems: 'center', gap: 5, minWidth: 0 },
  round: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth * 2,
  },
  label: { fontSize: 10, fontWeight: '600' },
  badge: {
    position: 'absolute',
    top: -3,
    right: -3,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 10, fontWeight: '800' },
  end: {
    alignSelf: 'center',
    minWidth: 200,
    height: 46,
    borderRadius: 23,
    paddingHorizontal: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  endCompact: { minWidth: 0, height: 44, borderRadius: 22, paddingHorizontal: 22, marginLeft: 6 },
  endText: { color: '#ffffff', fontSize: 16, fontWeight: '800' },
});
