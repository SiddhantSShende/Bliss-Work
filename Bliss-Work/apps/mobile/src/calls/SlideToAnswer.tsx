import { useMemo, useRef, useState } from 'react';
import { Phone, Video as VideoIcon } from 'lucide-react-native';
import { Animated, PanResponder, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { withAlpha } from '../lib/color';
import { radius, spacing } from '../constants/theme';
import { useAppTheme } from '../theme/ThemeProvider';
import { clampSlide, slideDecision } from './slideToAnswer';

const THUMB = 64;
const TRACK_H = 72;

/**
 * iPhone-style incoming-call slider: one track, one thumb that starts in the
 * middle. Drag it right past the threshold to answer, left to decline; let go
 * early and it springs back. The callbacks are the real accept/decline of the
 * call controllers — there is no second "pending" state here, and each gesture
 * can fire at most once.
 *
 * Swiping is not usable with every assistive technology, so the track also
 * exposes "Answer" / "Decline" as accessibility actions (TalkBack / VoiceOver).
 */
export function SlideToAnswer({
  media,
  onAnswer,
  onDecline,
}: {
  media: 'audio' | 'video';
  onAnswer: () => void;
  onDecline: () => void;
}) {
  const { colors } = useAppTheme();
  const [width, setWidth] = useState(0);
  const x = useRef(new Animated.Value(0)).current;
  const fired = useRef(false);
  // The responder is created once; it reads the live track width through a ref.
  const rangeRef = useRef(0);
  rangeRef.current = Math.max(0, (width - THUMB) / 2 - 4);
  const cbs = useRef({ onAnswer, onDecline });
  cbs.current = { onAnswer, onDecline };

  const commit = (d: 'answer' | 'decline') => {
    if (fired.current) return;
    fired.current = true;
    const to = d === 'answer' ? rangeRef.current : -rangeRef.current;
    Animated.timing(x, { toValue: to, duration: 90, useNativeDriver: false }).start();
    if (d === 'answer') cbs.current.onAnswer();
    else cbs.current.onDecline();
  };

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !fired.current,
        onMoveShouldSetPanResponder: () => !fired.current,
        // A parent (ScrollView, back-swipe) must not steal the drag mid-slide.
        onPanResponderTerminationRequest: () => false,
        onPanResponderMove: (_e, g) => {
          if (fired.current) return;
          x.setValue(clampSlide(g.dx, rangeRef.current));
        },
        onPanResponderRelease: (_e, g) => {
          if (fired.current) return;
          const d = slideDecision(clampSlide(g.dx, rangeRef.current), rangeRef.current);
          if (d) commit(d);
          else Animated.spring(x, { toValue: 0, useNativeDriver: false, bounciness: 8 }).start();
        },
        onPanResponderTerminate: () => {
          if (!fired.current) Animated.spring(x, { toValue: 0, useNativeDriver: false }).start();
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads everything through refs
    [x],
  );

  const range = rangeRef.current || 1;
  const answerOpacity = x.interpolate({ inputRange: [0, range * 0.6], outputRange: [1, 0], extrapolate: 'clamp' });
  const declineOpacity = x.interpolate({ inputRange: [-range * 0.6, 0], outputRange: [0, 1], extrapolate: 'clamp' });
  const thumbBg = x.interpolate({
    inputRange: [-range, 0, range],
    outputRange: [colors.danger, '#ffffff', colors.success],
    extrapolate: 'clamp',
  });
  const iconTint = x.interpolate({
    inputRange: [-range * 0.5, 0, range * 0.5],
    outputRange: [1, 0, 1],
    extrapolate: 'clamp',
  });

  const AnswerIcon = media === 'video' ? VideoIcon : Phone;
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);
  // Each hint lives beside the thumb, never under it: cap it to the free half.
  const hintMax = Math.max(0, (width - THUMB) / 2 - spacing.md * 2);

  return (
    <View
      onLayout={onLayout}
      style={[styles.track, { backgroundColor: withAlpha(colors.surface, 0.55), borderColor: withAlpha('#ffffff', 0.25) }]}
      accessible
      accessibilityLabel="Incoming call"
      accessibilityHint="Swipe right to answer, left to decline"
      accessibilityActions={[
        { name: 'answer', label: 'Answer' },
        { name: 'decline', label: 'Decline' },
      ]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'answer') commit('answer');
        else if (e.nativeEvent.actionName === 'decline') commit('decline');
      }}
    >
      <Animated.Text style={[styles.hintLeft, { color: colors.fg, opacity: declineOpacity, maxWidth: hintMax }]} numberOfLines={1} adjustsFontSizeToFit>
        ‹  Slide to Decline
      </Animated.Text>
      <Animated.Text style={[styles.hintRight, { color: colors.fg, opacity: answerOpacity, maxWidth: hintMax }]} numberOfLines={1} adjustsFontSizeToFit>
        Slide to Answer  ›
      </Animated.Text>

      <Animated.View
        {...pan.panHandlers}
        style={[
          styles.thumb,
          { backgroundColor: thumbBg, transform: [{ translateX: x }] },
        ]}
      >
        <AnswerIcon size={28} color={colors.success} />
        {/* Flips to white as the thumb takes on its green/red fill. */}
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.thumbIcon, { opacity: iconTint }]}>
          <AnswerIcon size={28} color="#ffffff" />
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: TRACK_H,
    borderRadius: radius.pill,
    borderWidth: 1,
    justifyContent: 'center',
    marginHorizontal: spacing.lg,
    overflow: 'hidden',
  },
  thumb: {
    position: 'absolute',
    alignSelf: 'center',
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  thumbIcon: { alignItems: 'center', justifyContent: 'center' },
  hintLeft: { position: 'absolute', left: spacing.md, fontSize: 14, fontWeight: '600' },
  hintRight: { position: 'absolute', right: spacing.md, fontSize: 14, fontWeight: '600' },
});
