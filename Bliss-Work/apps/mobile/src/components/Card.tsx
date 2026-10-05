import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { radius } from '../constants/theme';
import { GlassSurface } from './glass/GlassSurface';

interface CardProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Pressable rows (list items) sit flush against the screen edge and don't
   *  want the card's own padding — they apply their own per-row. */
  noPadding?: boolean;
  /** Skip the real backdrop blur (keep fill, reflection and edge). Use for cards
   *  repeated down a long list, where one blur view per row would cost scroll speed. */
  flat?: boolean;
}

/** The one glass surface every section/list/summary card sits on: translucent
 *  theme fill over a blurred backdrop, with the water-glass reflection and edge
 *  highlight (see GlassSurface). */
export function Card({ children, style, noPadding, flat }: CardProps) {
  return (
    <GlassSurface blur={!flat} borderRadius={radius.card} style={[!noPadding && styles.padding, style]}>
      {children}
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  padding: { padding: 16 },
});
