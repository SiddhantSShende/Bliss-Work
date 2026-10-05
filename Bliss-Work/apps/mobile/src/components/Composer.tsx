import { useContext, useEffect, useMemo, useState } from 'react';
import { BottomTabBarHeightContext } from '@react-navigation/bottom-tabs';
import { ActivityIndicator, Keyboard, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { FileText, Image as ImageIcon, MapPin, Plus, SendHorizontal, Smile } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radius, spacing, type ThemeColors } from '../constants/theme';
import { useThemeColors } from '../theme/ThemeProvider';
import { EmojiPickerPanel } from './EmojiPickerPanel';
import { MenuItem } from './MenuItem';
import { Modal } from './Modal';

interface ComposerProps {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  sending?: boolean;
  attachAvailable: boolean;
  /** Documents (any file type). */
  onAttach?: () => void;
  /** Photos & videos from the library; when set, the menu lists it beside "File". */
  onAttachMedia?: () => void;
  attachBusy?: boolean;
  onShareLocation?: () => void;
}

/**
 * The message composer. A single "+" opens the attach menu (photo/file,
 * location) so the bar stays uncluttered; the smiley toggles the full emoji
 * picker inline. Bottom padding follows the gesture-bar safe area, and drops
 * to zero while the keyboard is up (the keyboard already covers that inset).
 */
export function Composer({
  value,
  onChangeText,
  onSend,
  sending,
  attachAvailable,
  onAttach,
  onAttachMedia,
  attachBusy,
  onShareLocation,
}: ComposerProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  // Inside the tab navigator the tab bar sits directly under the composer and already
  // owns the bottom safe-area inset; adding it here too was the blank strip under the input.
  const tabBarShown = (useContext(BottomTabBarHeightContext) ?? 0) > 0;
  const insets = useSafeAreaInsets();
  const bottomInset = tabBarShown ? 0 : insets.bottom;
  const [showEmoji, setShowEmoji] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [keyboardUp, setKeyboardUp] = useState(false);
  const canSend = value.trim().length > 0 && !sending;
  const hasMenu = (attachAvailable && (!!onAttach || !!onAttachMedia)) || !!onShareLocation;

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => {
      setKeyboardUp(true);
      setShowEmoji(false);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardUp(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const toggleEmoji = () => {
    if (!showEmoji) Keyboard.dismiss();
    setShowEmoji((s) => !s);
  };

  return (
    <View style={[styles.wrap, { paddingBottom: keyboardUp || showEmoji ? 0 : bottomInset }]}>
      <View style={styles.bar}>
        {attachBusy ? (
          <View style={styles.iconButton}>
            <ActivityIndicator size="small" color={colors.muted} />
          </View>
        ) : hasMenu ? (
          <Pressable onPress={() => setMenuOpen(true)} style={styles.iconButton} hitSlop={8} accessibilityRole="button" accessibilityLabel="Attach">
            <Plus size={22} color={colors.muted} />
          </Pressable>
        ) : null}
        <Pressable onPress={toggleEmoji} style={styles.iconButton} hitSlop={8} accessibilityRole="button" accessibilityLabel="Emoji">
          <Smile size={20} color={showEmoji ? colors.accent : colors.muted} />
        </Pressable>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder="Message"
          placeholderTextColor={colors.muted}
          style={[styles.input, inputFocused && styles.inputFocused]}
          multiline
          onFocus={() => {
            setShowEmoji(false);
            setInputFocused(true);
          }}
          onBlur={() => setInputFocused(false)}
        />
        <Pressable onPress={onSend} disabled={!canSend} style={[styles.sendButton, !canSend && styles.sendButtonDisabled]} accessibilityRole="button" accessibilityLabel="Send">
          <SendHorizontal size={18} color={colors.accentFg} />
        </Pressable>
      </View>
      {showEmoji ? (
        <View style={[styles.emojiWrap, { paddingBottom: bottomInset }]}>
          <EmojiPickerPanel height={300} gutter={spacing.sm * 2} onSelect={(emoji) => onChangeText(value + emoji)} />
        </View>
      ) : null}

      <Modal visible={menuOpen} onClose={() => setMenuOpen(false)} title="Attach">
        {attachAvailable && onAttachMedia ? (
          <MenuItem
            icon={ImageIcon}
            label="Photo or video"
            divider
            onPress={() => {
              setMenuOpen(false);
              onAttachMedia();
            }}
          />
        ) : null}
        {attachAvailable && onAttach ? (
          <MenuItem
            icon={FileText}
            label={onAttachMedia ? 'File' : 'Photo or file'}
            divider={!!onShareLocation}
            onPress={() => {
              setMenuOpen(false);
              onAttach();
            }}
          />
        ) : null}
        {onShareLocation ? (
          <MenuItem
            icon={MapPin}
            label="Location"
            divider={false}
            onPress={() => {
              setMenuOpen(false);
              onShareLocation();
            }}
          />
        ) : null}
      </Modal>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    wrap: { backgroundColor: colors.surface },
    emojiWrap: { paddingHorizontal: spacing.sm, paddingTop: spacing.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
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
      backgroundColor: colors.input,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.card,
      paddingHorizontal: spacing.md,
      paddingVertical: 10,
      fontSize: 15,
      color: colors.fg,
    },
    inputFocused: { borderColor: colors.accent },
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
