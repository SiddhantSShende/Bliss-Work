import { useEffect, useMemo, useRef } from 'react';
import { Bell, ChevronDown, FileStack, ListChecks, Search, UserRound, type LucideIcon } from 'lucide-react-native';
import { Animated, Dimensions, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { radius, shadows, spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';

/** Where the popup's top-right corner lands, in screen coordinates — the
 *  trigger button's own `measureInWindow` result, read at press time (see
 *  ChatConversationScreen's `openHeaderMenu`). */
export interface ChatHeaderMenuAnchor {
  top: number;
  right: number;
}

interface ChatHeaderMenuProps {
  visible: boolean;
  anchor: ChatHeaderMenuAnchor | null;
  onClose: () => void;
  onViewProfile: () => void;
  onSearch: () => void;
  onMediaLinksDocs: () => void;
  onSelectMessages: () => void;
  onMuteNotifications: () => void;
  onMore: () => void;
  /** Swaps the "Mute"/"Unmute" label and icon fill for the current chat. */
  muted: boolean;
}

const POPUP_WIDTH = 240;

/**
 * The chat header's "⋮" menu — a small floating dropdown anchored just
 * below-right of the trigger icon, unlike ChatRowMenu/CallOptionsMenu's
 * full-screen bottom sheets (those stay exactly as they are; this is a
 * distinct pattern for a distinct kind of menu, not a replacement for
 * either). "More" hands off to the existing ChatRowMenu (Ignore/Clear
 * chat/Block) rather than duplicating those actions here.
 */
export function ChatHeaderMenu({
  visible,
  anchor,
  onClose,
  onViewProfile,
  onSearch,
  onMediaLinksDocs,
  onSelectMessages,
  onMuteNotifications,
  onMore,
  muted,
}: ChatHeaderMenuProps) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const scale = useRef(new Animated.Value(0.92)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) return;
    scale.setValue(0.92);
    opacity.setValue(0);
    Animated.parallel([
      Animated.timing(scale, { toValue: 1, duration: 140, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 120, useNativeDriver: true }),
    ]).start();
  }, [visible, scale, opacity]);

  if (!anchor) return null;

  const screenWidth = Dimensions.get('window').width;
  const width = Math.min(POPUP_WIDTH, screenWidth - spacing.lg * 2);
  // Clamped so a trigger near the very edge (or a narrow screen) can never
  // push the popup partly off-screen in either direction.
  const right = Math.max(spacing.sm, Math.min(anchor.right, screenWidth - width - spacing.sm));

  const run = (action: () => void) => {
    onClose();
    action();
  };

  const items: { key: string; label: string; icon: LucideIcon; onPress: () => void }[] = [
    { key: 'profile', label: 'View Profile', icon: UserRound, onPress: onViewProfile },
    { key: 'search', label: 'Search', icon: Search, onPress: onSearch },
    { key: 'media', label: 'Media, Links & Docs', icon: FileStack, onPress: onMediaLinksDocs },
    { key: 'select', label: 'Select Messages', icon: ListChecks, onPress: onSelectMessages },
    { key: 'mute', label: muted ? 'Unmute Notifications' : 'Mute Notifications', icon: Bell, onPress: onMuteNotifications },
    { key: 'more', label: 'More', icon: ChevronDown, onPress: onMore },
  ];

  return (
    <Modal visible={visible} animationType="none" transparent onRequestClose={onClose}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose}>
        <Animated.View style={[styles.wrapper, { top: anchor.top, right, width, opacity, transform: [{ scale }] }]}>
          <View style={styles.card}>
            {items.map((item, index) => (
              <Pressable
                key={item.key}
                onPress={() => run(item.onPress)}
                style={({ pressed }) => [
                  styles.item,
                  index < items.length - 1 && styles.itemDivider,
                  pressed && styles.itemPressed,
                ]}
              >
                <item.icon size={17} color={colors.fg} />
                <Text style={styles.itemText} numberOfLines={1}>
                  {item.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    wrapper: {
      position: 'absolute',
      ...shadows.soft,
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: radius.card,
      overflow: 'hidden',
    },
    item: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.sm + 2,
      paddingHorizontal: spacing.md,
    },
    itemDivider: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    itemPressed: {
      backgroundColor: colors.surface2,
    },
    itemText: {
      flex: 1,
      fontSize: 14,
      fontWeight: '500',
      color: colors.fg,
    },
  });
}
