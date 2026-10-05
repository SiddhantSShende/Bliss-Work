import { memo, useMemo } from 'react';
import { CheckSquare, ChevronRight } from 'lucide-react-native';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { AssigneeStatus, StickyTaskDTO } from '@taskboard/shared';
import { GlassSurface } from '../../components/glass/GlassSurface';
import { withAlpha } from '../../lib/color';
import { STATUS_LABEL } from '../../lib/taskStatus';
import { timeAgo } from '../../lib/timeAgo';
import { radius, spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';

/** Fixed so every card is the same height whatever the title length (a title takes up to two lines). */
export const RECENT_TASK_CARD_HEIGHT = 92;

function toneFor(status: AssigneeStatus, colors: ThemeColors): string {
  switch (status) {
    case 'SENT':
      return colors.warning;
    case 'ACKNOWLEDGED':
      return colors.accent;
    case 'COMPLETED':
      return colors.success;
    default:
      return colors.muted;
  }
}

interface Props {
  task: StickyTaskDTO;
  onPress: (taskId: string) => void;
}

/**
 * One row of Home's "Recent Tasks": the task's title (two lines, then an
 * ellipsis), who sent it, its status, and when it was assigned — every field is
 * on the task itself, nothing is derived or invented. Tapping opens that task's
 * existing detail screen by its real id. Glass without a blur view of its own
 * (frosted fill, reflection, edge) so five of them cost nothing to scroll.
 */
export const RecentTaskCard = memo(function RecentTaskCard({ task, onPress }: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const tone = toneFor(task.myStatus, colors);
  const sender = task.senderDisplayName || task.senderUsername;
  const status = STATUS_LABEL[task.myStatus];

  return (
    <GlassSurface blur={false} style={styles.card}>
      <Pressable
        onPress={() => onPress(task.taskId)}
        style={({ pressed }) => [styles.inner, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={`${task.title}. From ${sender}. ${status}.`}
      >
        <View style={styles.iconTile}>
          <CheckSquare size={20} color={colors.icon} />
        </View>
        <View style={styles.body}>
          <Text style={styles.title} numberOfLines={2}>
            {task.title}
          </Text>
          <View style={styles.metaRow}>
            <Text style={styles.sender} numberOfLines={1}>
              {sender}
            </Text>
            <View style={[styles.pill, { backgroundColor: withAlpha(tone, 0.16) }]}>
              <Text style={[styles.pillText, { color: tone }]} numberOfLines={1}>
                {status}
              </Text>
            </View>
          </View>
        </View>
        <View style={styles.trailing}>
          <Text style={styles.time}>{timeAgo(task.assignedAt)}</Text>
          <ChevronRight size={16} color={colors.muted} />
        </View>
      </Pressable>
    </GlassSurface>
  );
});

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    card: { height: RECENT_TASK_CARD_HEIGHT },
    inner: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.md },
    pressed: { opacity: 0.8 },
    iconTile: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft },
    body: { flex: 1, minWidth: 0, gap: 6 },
    title: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: colors.fg },
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    sender: { flexShrink: 1, fontSize: 12, color: colors.muted },
    pill: { flexShrink: 0, maxWidth: '60%', paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.pill },
    pillText: { fontSize: 11, fontWeight: '700' },
    trailing: { alignItems: 'flex-end', justifyContent: 'center', gap: spacing.xs, minWidth: 32 },
    time: { fontSize: 12, color: colors.muted },
  });
}
