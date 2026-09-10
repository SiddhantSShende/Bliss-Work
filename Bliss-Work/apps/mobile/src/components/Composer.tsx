import { useMemo, useState } from 'react';
import { Paperclip, SendHorizontal, Smile } from 'lucide-react-native';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { radius, spacing, type ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';
import { EmojiPicker } from './EmojiPicker';

interface ComposerProps {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  sending?: boolean;
  /** Gates the attachment button on whether this platform actually has a
   *  file-transfer transport — mirrors `useRuntime().rtcAvailable`, which
   *  already gates the identical button on web (see runtime.tsx: "rtcAvailable
   *  gates the file-transfer UI so the attach button only appears where a
   *  transport actually exists"). Mobile has none yet, so this renders false
   *  today; the button lights up for free once one is wired up. */
  attachAvailable: boolean;
  onAttach?: () => void;
}

/** Bottom message input bar: attachment (gated), emoji, text input, purple
 *  send button. The parent screen wraps this in a `KeyboardAvoidingView` so
 *  it stays pinned above the keyboard, same pattern `AuthScreenLayout` uses. */
export function Composer({ value, onChangeText, onSend, sending, attachAvailable, onAttach }: ComposerProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [showEmoji, setShowEmoji] = useState(false);
  const canSend = value.trim().length > 0 && !sending;

  return (
    <View>
      {showEmoji ? (
        <EmojiPicker onSelect={(emoji) => onChangeText(value + emoji)} />
      ) : null}
      <View style={styles.bar}>
        {attachAvailable ? (
          <Pressable onPress={onAttach} style={styles.iconButton} hitSlop={8}>
            <Paperclip size={20} color={colors.muted} />
          </Pressable>
        ) : null}
        <Pressable onPress={() => setShowEmoji((s) => !s)} style={styles.iconButton} hitSlop={8}>
          <Smile size={20} color={showEmoji ? colors.accent : colors.muted} />
        </Pressable>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder="Message"
          placeholderTextColor={colors.muted}
          style={styles.input}
          multiline
        />
        <Pressable
          onPress={onSend}
          disabled={!canSend}
          style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
        >
          <SendHorizontal size={18} color={colors.accentFg} />
        </Pressable>
      </View>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    bar: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: spacing.xs,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
      backgroundColor: colors.surface,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    iconButton: {
      width: 36,
      height: 36,
      alignItems: 'center',
      justifyContent: 'center',
    },
    input: {
      flex: 1,
      maxHeight: 120,
      backgroundColor: colors.surface2,
      borderRadius: radius.card,
      paddingHorizontal: spacing.md,
      paddingVertical: 10,
      fontSize: 15,
      color: colors.fg,
    },
    sendButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sendButtonDisabled: {
      opacity: 0.4,
    },
  });
}
