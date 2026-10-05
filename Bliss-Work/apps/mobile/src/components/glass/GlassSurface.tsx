import { memo, type ReactNode } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { withAlpha } from '../../lib/color';
import { radius as radii } from '../../constants/theme';
import { useAppTheme } from '../../theme/ThemeProvider';
import { useGlass, useInGlassOverlay } from './GlassProvider';

export type GlassVariant = 'card' | 'strong' | 'modal' | 'navigation';

interface GlassSurfaceProps {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** 1..100 backdrop blur. Defaults to the theme's own `blurIntensity`. */
  intensity?: number;
  borderRadius?: number;
  /** Replaces the opacity of the fill laid OVER the blur (lower = more backdrop shows through). */
  tintOpacity?: number;
  /** `card`: ordinary glass. `strong`: denser (menus, bubbles). `modal`: popup panels. `navigation`: the floating tab bar. */
  variant?: GlassVariant;
  /** Real backdrop blur. Turn off for rows inside long lists: the frosted fill, reflection
   *  and edge highlight stay, only the (costly) blur view is skipped. Default true. */
  blur?: boolean;
}

/**
 * A water-glass panel, bottom to top:
 *
 *   blurred backdrop -> translucent theme fill -> soft light reflection (a diagonal
 *   sheen plus a brighter top edge) -> hairline border + one-pixel specular edge
 *   -> your (sharp) content.
 *
 * Blur and decoration are absolutely-positioned SIBLINGS of `children`, never
 * their parent, so text and icons stay crisp — only what is behind the panel blurs.
 *
 *  - iOS: a native UIVisualEffectView; works anywhere.
 *  - Android: the blur view samples a named target view (see GlassProvider). In a
 *    popup it blurs the whole app; in a page it blurs the theme atmosphere. With no
 *    target available it falls back to a denser fill rather than faking blur.
 */
export const GlassSurface = memo(function GlassSurface({
  children,
  style,
  intensity,
  borderRadius = radii.card,
  tintOpacity,
  variant = 'card',
  blur = true,
}: GlassSurfaceProps) {
  const { colors, isDark } = useAppTheme();
  const glass = useGlass();
  const inOverlay = useInGlassOverlay();

  const androidTarget = Platform.OS === 'android' && blur ? (inOverlay ? glass?.targetRef : glass?.backgroundTargetRef) : undefined;
  const hasRealBlur = blur && (Platform.OS === 'ios' || !!androidTarget);

  const base =
    variant === 'modal' ? colors.modal : variant === 'navigation' ? colors.navigation : variant === 'strong' ? colors.surfaceStrong : colors.surface;
  // Without a blur behind it the fill alone has to keep text legible.
  const fill = tintOpacity !== undefined ? withAlpha(base, tintOpacity) : hasRealBlur || !blur ? base : withAlpha(base, 0.94);

  const r = colors.reflectionOpacity;
  const sheen = [withAlpha(colors.borderHighlight, r), withAlpha(colors.borderHighlight, 0), withAlpha(colors.accentSecondary, r * 0.55)] as const;
  const topGlow = [withAlpha(colors.borderHighlight, isDark ? 0.2 : 0.55), withAlpha(colors.borderHighlight, 0)] as const;

  return (
    <View style={[styles.base, { borderRadius, borderColor: colors.border }, style]}>
      {hasRealBlur ? (
        <BlurView
          intensity={intensity ?? colors.blurIntensity}
          tint={isDark ? 'dark' : 'light'}
          blurTarget={androidTarget}
          blurMethod="dimezisBlurView"
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: fill }]} />
      {/* Water-glass reflection: a soft diagonal sheen across the panel... */}
      <LinearGradient pointerEvents="none" colors={sheen} locations={[0, 0.5, 1]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      {/* ...a brighter wash along the top edge, like light catching the rim... */}
      <LinearGradient pointerEvents="none" colors={topGlow} start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }} style={styles.topGlow} />
      {/* ...and a one-pixel specular line. */}
      <View pointerEvents="none" style={[styles.highlight, { backgroundColor: colors.borderHighlight }]} />
      {children}
    </View>
  );
});

const styles = StyleSheet.create({
  base: { overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth * 2 },
  topGlow: { position: 'absolute', top: 0, left: 0, right: 0, height: 44 },
  highlight: { position: 'absolute', top: 0, left: 14, right: 14, height: StyleSheet.hairlineWidth * 2, opacity: 0.85 },
});
