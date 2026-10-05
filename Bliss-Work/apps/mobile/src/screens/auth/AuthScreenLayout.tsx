import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Logo } from '../../components/Logo';
import { FocusScrollContext } from '../../components/FocusScrollContext';
import { keyboardPadTarget } from '../../lib/androidKeyboardAvoid';
import { spacing, type ThemeColors } from '../../constants/theme';
import { useThemeColors } from '../../theme/ThemeProvider';

/** Air kept between the focused input and the keyboard / status bar. */
const FOCUS_MARGIN = 24;

/**
 * Shared chrome for every signed-out screen (Login, MFA challenge): centered
 * logo, title, optional subtitle, then the screen's own form below.
 *
 * Deliberately NOT a port of AuthLayout's desktop split-pane hero — that
 * panel is `hidden lg:flex` even on web, i.e. it's already considered
 * decoration a narrow viewport doesn't get. A phone screen is that narrow
 * viewport, so this is the mobile-native equivalent: the branded header a
 * phone auth screen normally has, not a shrunk two-column layout.
 *
 * Keyboard: the whole form is one ScrollView that is shrunk to the space above
 * the keyboard, and the focused input is scrolled into that space. iOS uses
 * KeyboardAvoidingView. Android cannot: the app is edge-to-edge
 * (`edgeToEdgeEnabled=true`), so `windowSoftInputMode=adjustResize` no longer
 * resizes the window and KeyboardAvoidingView's screenY math sees no keyboard
 * (see ChatKeyboardAvoider for the same root cause). Android therefore pads the
 * bottom by the IME height reported from the real WindowInsets.
 */
export function AuthScreenLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const colors = useThemeColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { height: windowH } = useWindowDimensions();
  const android = Platform.OS === 'android';

  const scroll = useRef<ScrollView>(null);
  const scrollY = useRef(0);
  const [kb, setKb] = useState(0);
  const kbRef = useRef(0);

  // Scroll just enough that the focused input sits above the keyboard (and below the status bar).
  const ensureFocusedVisible = useCallback(() => {
    const input = TextInput.State.currentlyFocusedInput?.();
    if (!input || !scroll.current) return;
    input.measureInWindow((_x, y, _w, h) => {
      const bottomEdge = windowH - (kbRef.current > 0 ? kbRef.current + insets.bottom : 0) - FOCUS_MARGIN;
      const topEdge = insets.top + FOCUS_MARGIN;
      let delta = 0;
      if (y + h > bottomEdge) delta = y + h - bottomEdge;
      else if (y < topEdge) delta = y - topEdge;
      if (delta !== 0) scroll.current?.scrollTo({ y: Math.max(0, scrollY.current + delta), animated: true });
    });
  }, [windowH, insets.top, insets.bottom]);

  useEffect(() => {
    if (!android) return;
    const show = Keyboard.addListener('keyboardDidShow', (e) => {
      kbRef.current = keyboardPadTarget(e);
      setKb(kbRef.current);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      kbRef.current = 0;
      setKb(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [android]);

  const body = (
    <FocusScrollContext.Provider value={ensureFocusedVisible}>
      <ScrollView
        ref={scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={android ? 'on-drag' : 'interactive'}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={(e) => {
          scrollY.current = e.nativeEvent.contentOffset.y;
        }}
        // The viewport shrinks / grows when the keyboard comes and goes: re-check the focused field.
        onLayout={ensureFocusedVisible}
      >
        {/* Tapping the empty space dismisses the keyboard; inputs and buttons take their own taps. */}
        <Pressable accessible={false} onPress={Keyboard.dismiss} style={styles.tapArea}>
          <View style={styles.header}>
            <Logo size={40} />
            <Text style={styles.title}>{title}</Text>
            {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          </View>
          <View style={styles.form}>{children}</View>
        </Pressable>
      </ScrollView>
    </FocusScrollContext.Provider>
  );

  if (!android) {
    return (
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        {body}
      </KeyboardAvoidingView>
    );
  }
  return (
    <View style={[styles.flex, { paddingTop: insets.top, paddingBottom: insets.bottom + kb }]}>{body}</View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: colors.bg },
    content: { flexGrow: 1, justifyContent: 'center' },
    tapArea: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.xl },
    header: { alignItems: 'center', gap: spacing.sm },
    title: { fontSize: 22, fontWeight: '700', color: colors.fg, marginTop: spacing.sm },
    subtitle: { fontSize: 14, color: colors.muted, textAlign: 'center' },
    form: { gap: spacing.md },
  });
}
