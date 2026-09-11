import { Pressable, StyleSheet, View } from 'react-native';
import type { ReactionDTO } from '@taskboard/shared';
import { spacing } from '../constants/theme';
import { Checkbox } from './Checkbox';
import { MessageBubble, type RenderableMessage } from './MessageBubble';
import { ReactionBar } from './ReactionBar';

interface MessageRowProps {
  message: RenderableMessage;
  mine: boolean;
  time: string;
  urlFor?: (id: string | undefined) => string | undefined;
  isResolved?: boolean;
  reactions: ReactionDTO[];
  onToggleReaction: (emoji: string, on: boolean) => void;
  reactionsDisabled?: boolean;
  selectionMode: boolean;
  selected: boolean;
  onToggleSelected: () => void;
  onLongPress: () => void;
}

/**
 * One message: bubble + reaction pills + selection checkbox, shared by
 * ChatConversationScreen and ChannelConversationScreen so the long-press →
 * MessageActionSheet / tap-a-pill-to-toggle / select-mode wiring is written
 * once — the two screens differ in which hooks and permissions feed this,
 * not in how a row looks or reacts to touch.
 */
export function MessageRow({
  message,
  mine,
  time,
  urlFor,
  isResolved,
  reactions,
  onToggleReaction,
  reactionsDisabled,
  selectionMode,
  selected,
  onToggleSelected,
  onLongPress,
}: MessageRowProps) {
  const bubble = <MessageBubble message={message} mine={mine} time={time} urlFor={urlFor} isResolved={isResolved} />;
  const pills = (
    <ReactionBar reactions={reactions} onToggle={onToggleReaction} mine={mine} disabled={reactionsDisabled || selectionMode} />
  );

  if (selectionMode) {
    return (
      <Pressable onPress={onToggleSelected} style={styles.selectableRow}>
        <Checkbox checked={selected} onPress={onToggleSelected} />
        <View style={styles.selectableBubble}>
          {bubble}
          {pills}
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable onLongPress={onLongPress} delayLongPress={250}>
      {bubble}
      {pills}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  selectableRow: { flexDirection: 'row', alignItems: 'center', paddingLeft: spacing.md },
  selectableBubble: { flex: 1 },
});
