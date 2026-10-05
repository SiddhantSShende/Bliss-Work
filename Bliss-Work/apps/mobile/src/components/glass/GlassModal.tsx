import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { spacing } from '../../constants/theme';
import { useAppTheme } from '../../theme/ThemeProvider';
import { GlassSurface } from './GlassSurface';
import { useGlass } from './GlassProvider';

export interface GlassModalProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** Fraction of the usable screen height the panel may grow to before its content scrolls. */
  maxHeight?: `${number}%`;
  contentStyle?: ViewStyle;
  /** `bottom` = sheet anchored to the bottom edge; `center` = floating dialog. */
  variant?: 'bottom' | 'center';
  /** Tapping the dimmed/blurred backdrop closes it. Default true. */
  dismissOnBackdrop?: boolean;
  /** How opaque the dimmed backdrop is (0-1). Default ~0.2 (light) / 0.42 (dark) —
   *  affects the margin OUTSIDE the panel (between it and the screen edge), not
   *  the panel itself. Raise it for a dialog whose FLOATING MARGIN sits over a
   *  screen with large accent-coloured buttons showing through there. */
  backdropOpacity?: number;
  /** How opaque the PANEL's own glass surface is (0-1, default ~0.6 light /
   *  0.52 dark — GlassSurface's own default). The panel's real-time blur alone
   *  only softens colour, it does not remove it: whatever sits directly BEHIND
   *  the panel (not just around it) still tints through at the default
   *  opacity. Raise this for a `center` dialog placed over a screen with a
   *  large solid accent-coloured control right behind where the panel lands
   *  (e.g. the date/time pickers, over "Start Now"/"Schedule"). */
  panelTintOpacity?: number;
  /** Wrap children in a ScrollView (default). Pass false when the content is its own
   *  virtualised list (e.g. the emoji grid) so lists aren't nested in a ScrollView. */
  scroll?: boolean;
}

const ENTER_MS = 180;
const EXIT_MS = 140;

/**
 * Glass popup / sheet. Renders into GlassProvider's overlay layer (NOT an RN
 * <Modal>) so the app behind it can be genuinely blurred on Android as well as
 * iOS. Stays mounted just long enough to play its exit animation.
 *
 * Behaviour: Android hardware-back closes it, the keyboard lifts it, content
 * scrolls when taller than the screen, it respects safe-area insets, and
 * nothing behind it receives touches while it is open.
 */
export function GlassModal(props: GlassModalProps) {
  const { visible, onClose } = props;
  const glass = useGlass();
  const id = useId();
  const progress = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.timing(progress, { toValue: 1, duration: ENTER_MS, useNativeDriver: true }).start();
      return;
    }
    Animated.timing(progress, { toValue: 0, duration: EXIT_MS, useNativeDriver: true }).start(({ finished }) => {
      if (finished) setMounted(false);
    });
  }, [visible, progress]);

  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, onClose]);

  // Publish the layer after every render so children/props stay current.
  useEffect(() => {
    if (!glass) return;
    if (mounted) glass.setLayer(id, <GlassModalLayer {...props} progress={progress} />);
    else glass.removeLayer(id);
  });
  const removeLayer = glass?.removeLayer;
  useEffect(() => () => removeLayer?.(id), [removeLayer, id]);

  return null;
}

function GlassModalLayer({
  onClose,
  title,
  children,
  maxHeight = '80%',
  contentStyle,
  variant = 'bottom',
  dismissOnBackdrop = true,
  scroll = true,
  backdropOpacity,
  panelTintOpacity,
  progress,
}: GlassModalProps & { progress: Animated.Value }) {
  const { colors, isDark } = useAppTheme();
  const glass = useGlass();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();

  const usable = height - insets.top - insets.bottom - spacing.lg * 2;
  const panelMax = Math.min((parseFloat(maxHeight) / 100) * height, usable);
  const isCenter = variant === 'center';

  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [isCenter ? 12 : 40, 0] });
  const scale = progress.interpolate({ inputRange: [0, 1], outputRange: [isCenter ? 0.96 : 1, 1] });

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: progress }]}>
        <BlurView
          intensity={Platform.OS === 'ios' ? 40 : 55}
          tint={isDark ? 'dark' : 'light'}
          blurTarget={Platform.OS === 'android' ? glass?.targetRef : undefined}
          blurMethod="dimezisBlurView"
          style={StyleSheet.absoluteFill}
        />
        <View
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: isDark ? `rgba(0,0,0,${backdropOpacity ?? 0.42})` : `rgba(20,20,40,${backdropOpacity ?? 0.2})` },
          ]}
        />
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={dismissOnBackdrop ? onClose : undefined}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
      </Animated.View>

      <KeyboardAvoidingView
        behavior="padding"
        pointerEvents="box-none"
        style={[
          StyleSheet.absoluteFill,
          {
            justifyContent: isCenter ? 'center' : 'flex-end',
            paddingTop: insets.top + spacing.lg,
            paddingHorizontal: isCenter ? spacing.lg : 0,
            paddingBottom: isCenter ? insets.bottom + spacing.lg : 0,
          },
        ]}
      >
        <Animated.View
          pointerEvents="box-none"
          style={{ opacity: progress, transform: [{ translateY }, { scale }], alignItems: 'center' }}
        >
          <GlassSurface
            variant="modal"
            borderRadius={24}
            tintOpacity={panelTintOpacity}
            style={[
              styles.panel,
              { maxHeight: panelMax },
              !isCenter && styles.sheet,
              !isCenter && { paddingBottom: insets.bottom + spacing.md },
            ]}
          >
            {!isCenter ? <View style={[styles.handle, { backgroundColor: colors.muted }]} /> : null}
            {title ? (
              <View style={styles.header}>
                <Text style={[styles.title, { color: colors.fg }]} numberOfLines={2}>
                  {title}
                </Text>
                <Pressable
                  onPress={onClose}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel="Close"
                  style={[styles.closeBtn, { backgroundColor: colors.surface2 }]}
                >
                  <X size={16} color={colors.fg} />
                </Pressable>
              </View>
            ) : null}
            {scroll ? (
              <ScrollView
                style={styles.scroll}
                contentContainerStyle={[styles.body, contentStyle]}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                bounces={false}
              >
                {children}
              </ScrollView>
            ) : (
              <View style={[styles.body, contentStyle]}>{children}</View>
            )}
          </GlassSurface>
        </Animated.View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { width: '100%', maxWidth: 520, elevation: 0 },
  sheet: { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, marginTop: spacing.sm, opacity: 0.4 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  title: { flex: 1, fontSize: 18, fontWeight: '700' },
  closeBtn: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  scroll: { flexGrow: 0, flexShrink: 1 },
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md, paddingTop: spacing.xs },
});
