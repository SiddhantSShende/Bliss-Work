import { useId } from 'react';
import Svg, { Circle, Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { useThemeColors } from '../theme/ThemeProvider';

/**
 * BlissWork mark: a "B" monogram with a chat bubble + three dots in the
 * lower lobe. Ported from packages/ui/src/components/Logo.tsx — same paths,
 * gradient stops resolved to their theme.ts values since react-native-svg
 * has no CSS custom properties to read.
 */
export function Logo({ size = 32 }: { size?: number }) {
  const colors = useThemeColors();
  const id = useId().replace(/:/g, '');
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      <Defs>
        <LinearGradient id={`bw-${id}`} x1="6" y1="4" x2="42" y2="44" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor={colors.brandFrom} />
          <Stop offset="1" stopColor={colors.brandTo} />
        </LinearGradient>
      </Defs>
      <Rect x="9" y="6" width="10.5" height="36" rx="5.25" fill={`url(#bw-${id})`} />
      <Path
        d="M9,6 L30,6 Q39.4,6 39.4,15.94 Q39.4,22.5 33.75,24 Q39.4,25.5 39.4,32.06 Q39.4,42 31.88,42 L9,42 Z"
        fill={`url(#bw-${id})`}
      />
      <Rect x="12.94" y="27.38" width="26.06" height="10.31" rx="2.53" fill="white" />
      <Path d="M15.94,37.69 L11.63,37.69 L9.38,42.19 Q9.09,42.84 9.84,42.38 Z" fill="white" />
      <Circle cx="20.53" cy="32.53" r="1.5" fill={colors.brandFrom} />
      <Circle cx="25.97" cy="32.53" r="1.5" fill={colors.accent} />
      <Circle cx="31.41" cy="32.53" r="1.5" fill={colors.brandTo} />
    </Svg>
  );
}
