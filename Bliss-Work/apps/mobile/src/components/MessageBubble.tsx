import { useMemo } from 'react';
import { Check, CheckCheck, Clock } from 'lucide-react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, Text, View } from 'react-native';
import type { MessageDTO } from '@taskboard/shared';
import { radius, spacing, type ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';

/** The subset of MessageDTO/ChannelMessageDTO this bubble actually renders —
 *  shared by DMs and channels, which is why this isn't just `MessageDTO`:
 *  ChannelMessageDTO has no `status` field (no per-viewer read receipt on
 *  channel messages) and no `conversationId`, so it doesn't structurally
 *  satisfy MessageDTO. */
interface RenderableMessage {
  body: string;
  status?: MessageDTO['status'];
  deletedForAll?: boolean;
}

interface MessageBubbleProps {
  message: RenderableMessage;
  /** Whether the signed-in user sent this one — the only thing that decides
   *  alignment/color; there is no other "mine" signal on the DTO itself. */
  mine: boolean;
  time: string;
}

/** One chat/channel message bubble: purple gradient for outgoing, light
 *  surface for incoming, per the reference. Read-receipt ticks only ever
 *  render on the sender's own bubbles (`MessageDTO.status` is documented as
 *  "set only on the sender's own bubbles"). */
export function MessageBubble({ message, mine, time }: MessageBubbleProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  if (message.deletedForAll) {
    return (
      <View style={[styles.row, mine && styles.rowMine]}>
        <View style={[styles.bubble, styles.tombstone]}>
          <Text style={styles.tombstoneText}>This message was deleted</Text>
        </View>
      </View>
    );
  }

  const body = (
    <>
      <Text style={mine ? styles.textMine : styles.textTheirs}>{message.body}</Text>
      <View style={styles.meta}>
        <Text style={mine ? styles.timeMine : styles.timeTheirs}>{time}</Text>
        {mine ? <ReceiptIcon status={message.status} /> : null}
      </View>
    </>
  );

  return (
    <View style={[styles.row, mine && styles.rowMine]}>
      {mine ? (
        <LinearGradient
          colors={[colors.brandFrom, colors.brandTo]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[styles.bubble, styles.bubbleMine]}
        >
          {body}
        </LinearGradient>
      ) : (
        <View style={[styles.bubble, styles.bubbleTheirs]}>{body}</View>
      )}
    </View>
  );
}

function ReceiptIcon({ status }: { status: MessageDTO['status'] }) {
  if (status === 'SEEN') return <CheckCheck size={14} color="#dbeafe" />;
  if (status === 'DELIVERED') return <CheckCheck size={14} color="rgba(255,255,255,0.75)" />;
  if (status === 'SENT') return <Check size={14} color="rgba(255,255,255,0.75)" />;
  return <Clock size={12} color="rgba(255,255,255,0.6)" />;
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      justifyContent: 'flex-start',
      paddingHorizontal: spacing.md,
      marginVertical: 3,
    },
    rowMine: {
      justifyContent: 'flex-end',
    },
    bubble: {
      maxWidth: '78%',
      borderRadius: radius.card,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    bubbleMine: {
      borderBottomRightRadius: 4,
    },
    bubbleTheirs: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderBottomLeftRadius: 4,
    },
    textMine: {
      color: colors.accentFg,
      fontSize: 15,
      lineHeight: 20,
    },
    textTheirs: {
      color: colors.fg,
      fontSize: 15,
      lineHeight: 20,
    },
    meta: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: 4,
      marginTop: 2,
    },
    timeMine: {
      fontSize: 11,
      color: 'rgba(255,255,255,0.8)',
    },
    timeTheirs: {
      fontSize: 11,
      color: colors.muted,
    },
    tombstone: {
      backgroundColor: colors.surface2,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.card,
    },
    tombstoneText: {
      fontSize: 13,
      fontStyle: 'italic',
      color: colors.muted,
    },
  });
}
