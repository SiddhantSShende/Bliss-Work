import { memo } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Defs, G, LinearGradient as SvgLinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import { artFor } from '../../theme/themes';
import { useAppTheme } from '../../theme/ThemeProvider';

/**
 * The atmosphere behind the whole app — one per theme: a diagonal base gradient,
 * a few soft pools of light (radial gradients, so there is no hard edge anywhere)
 * and two faint flowing ribbons. It is painted ONCE, under every screen (screens
 * are transparent), and it is the backdrop the glass panels blur and tint, which
 * is what makes them read as glass instead of coloured boxes.
 *
 * Static on purpose: nothing animates, so it costs one draw and never competes
 * with scrolling.
 */
export const ThemeBackground = memo(function ThemeBackground() {
  const { family, mode } = useAppTheme();
  const art = artFor(family, mode);
  const key = `${family}-${mode}`;
  const { width, height } = useWindowDimensions();

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <LinearGradient colors={art.gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
        <Defs>
          {art.blobs.map((b, i) => (
            <RadialGradient key={`b${i}`} id={`${key}-b${i}`} cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor={b.color} stopOpacity={b.opacity} />
              <Stop offset="0.55" stopColor={b.color} stopOpacity={b.opacity * 0.35} />
              <Stop offset="1" stopColor={b.color} stopOpacity={0} />
            </RadialGradient>
          ))}
          {art.ribbons.map((r, i) => (
            <SvgLinearGradient key={`r${i}`} id={`${key}-r${i}`} x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor={r.from} stopOpacity={r.opacity} />
              <Stop offset="1" stopColor={r.to} stopOpacity={0} />
            </SvgLinearGradient>
          ))}
        </Defs>
        {art.blobs.map((b, i) => {
          const r = b.r * width;
          return <Rect key={`bl${i}`} x={b.x * width - r} y={b.y * height - r} width={r * 2} height={r * 2} fill={`url(#${key}-b${i})`} />;
        })}
        <G transform={`scale(${width / 100} ${height / 200})`}>
          {art.ribbons.map((r, i) => (
            <Path key={`rb${i}`} d={r.d} fill={`url(#${key}-r${i})`} />
          ))}
        </G>
      </Svg>
    </View>
  );
});
