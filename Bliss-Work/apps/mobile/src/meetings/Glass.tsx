import { createContext, useContext, type ReactNode, type RefObject } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { useMeetingSkin } from './skin';

/**
 * Real background blur for the meeting's panels, menus and dialogs.
 *
 * The blurred thing is the LIVE MEETING BEHIND the panel (header, stage,
 * tiles), not the app under the call: `MeetingRoom` wraps its stage in a
 * BlurTargetView and publishes its ref here; every `GlassPanel` below points
 * its BlurView at it. On Android expo-blur only blurs a named target that does
 * not contain the BlurView, hence the sibling structure:
 *
 *   [ stage (BlurTargetView) ]   <- what gets blurred
 *   [ BlurView -> tint wash -> sharp children ]   <- the panel
 *
 * Text and controls are children of the panel, drawn above the blur and wash,
 * so they stay sharp. (A video surface is not captured by Android's blur; the
 * avatars, gradient and everything else are. iOS blurs video natively.)
 */
export const StageBlurTarget = createContext<RefObject<View | null> | null>(null);

interface GlassPanelProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  radius?: number;
  intensity?: number;
}

export function GlassPanel({ children, style, radius = 24, intensity = 70 }: GlassPanelProps) {
  const skin = useMeetingSkin();
  const target = useContext(StageBlurTarget);
  const android = Platform.OS === 'android';
  return (
    <View style={[{ borderRadius: radius, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth * 2, borderColor: skin.glassBorder }, style]}>
      <BlurView
        intensity={intensity}
        tint="dark"
        blurTarget={android ? (target ?? undefined) : undefined}
        blurMethod={android && target ? 'dimezisBlurView' : 'none'}
        style={StyleSheet.absoluteFill}
      />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: skin.glass }]} />
      {children}
    </View>
  );
}

/** A full-screen blurred+dimmed backdrop behind a dialog or menu. Tapping it
 *  runs `onPress`. Blurs the meeting behind it, like the panels. */
export function GlassBackdrop({ onPress }: { onPress?: () => void }) {
  const skin = useMeetingSkin();
  const target = useContext(StageBlurTarget);
  const android = Platform.OS === 'android';
  return (
    <View style={StyleSheet.absoluteFill}>
      <BlurView
        intensity={45}
        tint="dark"
        blurTarget={android ? (target ?? undefined) : undefined}
        blurMethod={android && target ? 'dimezisBlurView' : 'none'}
        style={StyleSheet.absoluteFill}
      />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: skin.scrim }]} />
      {onPress ? <View style={StyleSheet.absoluteFill} onStartShouldSetResponder={() => true} onResponderRelease={onPress} accessibilityLabel="Dismiss" /> : null}
    </View>
  );
}
