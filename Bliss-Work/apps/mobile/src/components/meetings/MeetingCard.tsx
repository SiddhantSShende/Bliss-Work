import { memo, useMemo } from 'react';
import { Mic, Video } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { CallDTO } from '@taskboard/shared';
import { GlassCard } from './MeetingsGlass';
import { spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';
import {
  formatDuration,
  formatTimeRange,
  isPast,
  meetingPlatform,
  meetingStart,
  participantCount,
} from '../../lib/meetings';
import { withAlpha } from '../../lib/color';
import { startsInLabel } from '../../lib/meetingSchedule';

interface MeetingCardProps {
  meeting: CallDTO;
  onPress: (meeting: CallDTO) => void;
  onJoin: (meeting: CallDTO) => void;
  /** Prefix the time with the date — for lists that span several days. */
  showDate?: boolean;
}

/** One meeting row: icon tile, title, time range, and a
 *  "platform · duration · people" line. Past meetings are drawn quieter
 *  (muted tile, no Join) but on the same glass surface. */
function MeetingCardImpl({ meeting, onPress, onJoin, showDate }: MeetingCardProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const past = isPast(meeting);
  const live = meeting.status === 'LIVE';
  const cancelled = meeting.status === 'CANCELLED';
  const Icon = meeting.media === 'audio' ? Mic : Video;

  const time = formatTimeRange(meeting);
  const when = showDate
    ? `${meetingStart(meeting).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${time}`
    : time;
  // "Starts in 8 minutes" for a scheduled meeting that has not begun yet.
  const startsIn = meeting.status === 'SCHEDULED' && meeting.scheduledAt ? startsInLabel(new Date(meeting.scheduledAt), Date.now()) : null;
  const people = participantCount(meeting);
  const meta = [
    meetingPlatform(meeting),
    formatDuration(meeting),
    people > 1 ? `${people} people` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <GlassCard blur={false} style={past && styles.pastCard}>
      <Pressable
        onPress={() => onPress(meeting)}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={`${meeting.title || 'Meeting'}, ${when}`}
      >
        <View style={[styles.iconTile, past && styles.iconTilePast]}>
          <Icon size={20} color={past ? colors.muted : colors.accent} />
        </View>
        <View style={styles.text}>
          <Text style={[styles.title, past && styles.titlePast]} numberOfLines={1}>
            {meeting.title || 'Meeting'}
          </Text>
          <Text style={styles.when} numberOfLines={1}>
            {when}
          </Text>
          {startsIn ? (
            <Text style={styles.startsIn} numberOfLines={1}>
              {startsIn}
            </Text>
          ) : null}
          <Text style={styles.meta} numberOfLines={1}>
            {cancelled ? `Cancelled · ${meta}` : meta}
          </Text>
        </View>
        {!past ? (
          <Pressable
            onPress={() => onJoin(meeting)}
            hitSlop={8}
            style={({ pressed }) => [styles.join, live && styles.joinLive, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={`Join ${meeting.title || 'meeting'}`}
          >
            <Text style={[styles.joinText, live && styles.joinTextLive]}>{live ? 'Join live' : 'Join'}</Text>
          </Pressable>
        ) : null}
      </Pressable>
    </GlassCard>
  );
}

export const MeetingCard = memo(MeetingCardImpl);

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    pastCard: { opacity: 0.86 },
    startsIn: { fontSize: 12, fontWeight: '600', color: colors.accent },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.md,
    },
    pressed: { opacity: 0.7 },
    iconTile: {
      width: 44,
      height: 44,
      borderRadius: 14,
      backgroundColor: colors.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    iconTilePast: { backgroundColor: colors.surface2 },
    // minWidth 0 lets the column shrink so long titles truncate instead of
    // pushing the Join pill off-screen.
    text: { flex: 1, minWidth: 0, gap: 2 },
    title: { fontSize: 15, fontWeight: '700', color: colors.fg },
    titlePast: { fontWeight: '600' },
    when: { fontSize: 12.5, fontWeight: '500', color: colors.fg, opacity: 0.75 },
    meta: { fontSize: 12, color: colors.muted },
    join: {
      paddingHorizontal: spacing.md,
      paddingVertical: 7,
      borderRadius: 999,
      backgroundColor: withAlpha(colors.accent, 0.14),
    },
    joinLive: { backgroundColor: colors.accent },
    joinText: { fontSize: 12.5, fontWeight: '700', color: colors.accent },
    joinTextLive: { color: colors.accentFg },
  });
}
