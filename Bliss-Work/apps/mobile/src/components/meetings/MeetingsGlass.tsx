import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { GlassSurface } from '../glass/GlassSurface';

/**
 * Glass for the Meetings screens — a thin veneer over the app-wide
 * `GlassSurface`, so Meetings uses the same blur, reflection, edge and theme
 * tokens as every other screen (it used to carry a second, private glass
 * implementation and its own backdrop).
 */

/** Page wrapper kept for the Meetings screens: the atmosphere is the app-wide one now. */
export function GlassBackdrop({ children }: { children: ReactNode }) {
  return <View style={styles.fill}>{children}</View>;
}

interface MeetingGlassProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  borderRadius?: number;
  /** Real backdrop blur. Off for cards repeated down a list. */
  blur?: boolean;
}

export function MeetingGlass({ children, style, borderRadius = 16, blur = true }: MeetingGlassProps) {
  return (
    <GlassSurface borderRadius={borderRadius} blur={blur} style={style}>
      {children}
    </GlassSurface>
  );
}

/** Standard 16-radius card. */
export function GlassCard({ children, style, blur }: { children: ReactNode; style?: StyleProp<ViewStyle>; blur?: boolean }) {
  return (
    <MeetingGlass style={style} blur={blur}>
      {children}
    </MeetingGlass>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
