import { useContext, useEffect, useRef, type ReactNode } from 'react';
import { Animated, Keyboard, KeyboardAvoidingView, Platform, type StyleProp, type ViewStyle } from 'react-native';
import { BottomTabBarHeightContext } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KEYBOARD_PAD_DURATION_MS, keyboardPadTarget, padAboveKeyboard } from '../lib/androidKeyboardAvoid';

/**
 * Keeps a chat's message list + composer clear of the on-screen keyboard —
 * `ChatConversationScreen` and `ChannelConversationScreen`'s shared wrapper.
 *
 * iOS uses `KeyboardAvoidingView`'s own "padding" behavior, unchanged: its
 * keyboard-frame reporting is reliable and this already worked.
 *
 * Android does NOT use `KeyboardAvoidingView`. Its "padding" math compares
 * this view's own layout to the keyboard event's `screenY`, and Android
 * derives `screenY` from the legacy `getWindowVisibleDisplayFrame()` (see
 * react-native's `ReactRootView.checkForKeyboardEvents()`). With edge-to-edge
 * enabled (this app's `edgeToEdgeEnabled=true`) `windowSoftInputMode=
 * "adjustResize"` no longer actually resizes the window on modern Android, so
 * that display frame never shrinks — the computed offset stays ~0 and the
 * composer sits exactly where it always did: behind the keyboard. The event's
 * own `height` field is unaffected — it comes straight from the IME
 * WindowInsets — so this reads that directly (`keyboardPadTarget`) and
 * applies it as animated bottom padding itself, sidestepping the broken
 * `screenY` math entirely.
 */
export function ChatKeyboardAvoider({
  style,
  iosKeyboardVerticalOffset,
  children,
}: {
  style?: StyleProp<ViewStyle>;
  /** Same contract as `KeyboardAvoidingView`'s own `keyboardVerticalOffset` — iOS only. */
  iosKeyboardVerticalOffset: number;
  children: ReactNode;
}) {
  if (Platform.OS === 'ios') {
    return (
      <KeyboardAvoidingView style={style} behavior="padding" keyboardVerticalOffset={iosKeyboardVerticalOffset}>
        {children}
      </KeyboardAvoidingView>
    );
  }
  return <AndroidKeyboardPad style={style}>{children}</AndroidKeyboardPad>;
}

function AndroidKeyboardPad({ style, children }: { style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const height = useRef(new Animated.Value(0)).current;
  // These screens sit ABOVE the tab bar; the keyboard covers the tab bar as well,
  // so that much of it must not be padded again (see padAboveKeyboard).
  const tabBarHeight = useContext(BottomTabBarHeightContext) ?? 0;
  const bottomInset = useSafeAreaInsets().bottom;
  const below = useRef({ tabBarHeight, bottomInset });
  below.current = { tabBarHeight, bottomInset };

  useEffect(() => {
    const animateTo = (toValue: number) =>
      Animated.timing(height, { toValue, duration: KEYBOARD_PAD_DURATION_MS, useNativeDriver: false }).start();
    const show = Keyboard.addListener('keyboardDidShow', (e) =>
      animateTo(padAboveKeyboard(keyboardPadTarget(e), below.current.bottomInset, below.current.tabBarHeight)),
    );
    const hide = Keyboard.addListener('keyboardDidHide', () => animateTo(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [height]);

  return <Animated.View style={[style, { paddingBottom: height }]}>{children}</Animated.View>;
}
