import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { StyleSheet, View } from 'react-native';
import { BlurTargetView } from 'expo-blur';
import { ThemeBackground } from './ThemeBackground';

/**
 * Real background blur needs two things to line up:
 *
 *  - iOS: a UIVisualEffectView blurs whatever is composited beneath it, so any
 *    BlurView drawn over the app works.
 *  - Android: expo-blur's BlurView (Dimezis) blurs a specific *target* view, which
 *    must be in the SAME window and must NOT contain the BlurView. A React Native
 *    <Modal> is its own window, so it can never blur the app behind it.
 *
 * So popups are not RN Modals. This provider wraps the whole app in one
 * `BlurTargetView` and renders popup layers as its *siblings*, on top. A layer's
 * BlurView points at `targetRef`, which is the app underneath it.
 *
 * In-page glass cards need the same trick one level down: inside the app target
 * the theme's atmosphere is a SECOND, nested target (`backgroundTargetRef`) that
 * holds only the background art. A card's BlurView samples that, so it blurs the
 * atmosphere behind it and is never inside its own target. The screens above are
 * transparent, which is what lets the atmosphere show through them.
 */
interface GlassContextValue {
  /** The whole app (atmosphere + screens): what POPUP layers blur. */
  targetRef: RefObject<View | null>;
  /** Only the atmospheric background: what IN-PAGE glass cards blur on Android. It contains no
   *  screen content, so a card's own BlurView is never inside its target. */
  backgroundTargetRef: RefObject<View | null>;
  /** Add or replace an overlay layer (called on every render of its owner). */
  setLayer: (id: string, node: ReactNode) => void;
  removeLayer: (id: string) => void;
}

const GlassContext = createContext<GlassContextValue | null>(null);

/** True inside an overlay layer — the only place an Android BlurView can legally target the app. */
const OverlayContext = createContext(false);

export function useGlass(): GlassContextValue | null {
  return useContext(GlassContext);
}

export function useInGlassOverlay(): boolean {
  return useContext(OverlayContext);
}

export function GlassProvider({ children }: { children: ReactNode }) {
  const targetRef = useRef<View>(null);
  const backgroundTargetRef = useRef<View>(null);
  const [layers, setLayers] = useState<{ id: string; node: ReactNode }[]>([]);

  const setLayer = useCallback((id: string, node: ReactNode) => {
    setLayers((prev) => {
      const i = prev.findIndex((l) => l.id === id);
      if (i === -1) return [...prev, { id, node }];
      const next = prev.slice();
      next[i] = { id, node };
      return next;
    });
  }, []);

  const removeLayer = useCallback((id: string) => {
    setLayers((prev) => (prev.some((l) => l.id === id) ? prev.filter((l) => l.id !== id) : prev));
  }, []);

  const value = useMemo(() => ({ targetRef, backgroundTargetRef, setLayer, removeLayer }), [setLayer, removeLayer]);

  return (
    <GlassContext.Provider value={value}>
      <View style={styles.root}>
        <BlurTargetView ref={targetRef} style={styles.root}>
          {/* The atmosphere sits under every screen and is its own blur target. */}
          <BlurTargetView ref={backgroundTargetRef} style={StyleSheet.absoluteFill} pointerEvents="none">
            <ThemeBackground />
          </BlurTargetView>
          <View style={styles.root}>{children}</View>
        </BlurTargetView>
        {layers.map((l) => (
          <View key={l.id} style={styles.layer} pointerEvents="box-none">
            <OverlayContext.Provider value>{l.node}</OverlayContext.Provider>
          </View>
        ))}
      </View>
    </GlassContext.Provider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  layer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000, elevation: 1000 },
});
