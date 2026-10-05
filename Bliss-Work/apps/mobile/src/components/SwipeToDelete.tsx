import React, { useEffect, useRef, useState } from 'react';
import { Animated, PanResponder, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { SWIPE_OPEN_WIDTH, swipeSettle } from '../lib/swipeSettle';
import { useThemeColors } from '../theme/ThemeProvider';

const swipeEmitter = new (class {
  private listeners = new Set<(id: string) => void>();
  subscribe(cb: (id: string) => void) {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
  /** Tell every row except `id` to close. */
  open(id: string) {
    this.listeners.forEach((cb) => cb(id));
  }
})();

/** Close every row that is currently swiped open (list scrolled, refreshed, screen left…). */
export function closeOpenSwipeRows() {
  swipeEmitter.open('');
}

interface SwipeToDeleteProps {
  swipeId: string;
  children: React.ReactNode;
  onDelete: () => void | Promise<void>;
  deleteActionComponent: React.ReactNode;
}

/**
 * A row that reveals Delete when pulled left. The red lives ONLY in a strip that
 * rides the row's right edge, so it exists only while the row is pulled aside —
 * at rest nothing red is under (or behind) the row, whatever the row's fill.
 * Resting state is closed (0) or open (-SWIPE_OPEN_WIDTH); `swipeSettle` decides
 * which, or whether the pull is a delete.
 */
export function SwipeToDelete({ swipeId, children, onDelete, deleteActionComponent }: SwipeToDeleteProps) {
  const colors = useThemeColors();
  const { width } = useWindowDimensions();
  const widthRef = useRef(width);
  widthRef.current = width;
  const translateX = useRef(new Animated.Value(0)).current;
  const [deleted, setDeleted] = useState(false);
  /** Where the row is resting (or heading): 0 closed, -SWIPE_OPEN_WIDTH open. */
  const resting = useRef(0);
  const gestureStart = useRef(0);
  // The PanResponder below is created once, so it reads the latest onDelete and a guard
  // that survives re-renders — closing over props/state would freeze the first render's.
  const onDeleteRef = useRef(onDelete);
  onDeleteRef.current = onDelete;
  const deletingRef = useRef(false);

  const snapTo = (to: number) => {
    resting.current = to;
    Animated.spring(translateX, { toValue: to, useNativeDriver: true }).start();
  };

  useEffect(() => {
    const unsubscribe = swipeEmitter.subscribe((id) => {
      if (id !== swipeId && resting.current !== 0 && !deletingRef.current) snapTo(0);
    });
    return () => {
      unsubscribe();
      translateX.stopAnimation();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swipeId, translateX]);

  const runDelete = () => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    resting.current = -widthRef.current;
    Animated.timing(translateX, { toValue: -widthRef.current, duration: 180, useNativeDriver: true }).start(async ({ finished }) => {
      if (!finished) {
        deletingRef.current = false;
        return;
      }
      setDeleted(true);
      try {
        await onDeleteRef.current();
      } catch {
        // The caller already told the user why; put the row back, fully closed.
        deletingRef.current = false;
        setDeleted(false);
        snapTo(0);
      }
    });
  };

  const panResponder = useRef(
    PanResponder.create({
      // A tap on an open row closes it (via release) instead of opening the chat underneath.
      onStartShouldSetPanResponderCapture: () => resting.current !== 0 && !deletingRef.current,
      onStartShouldSetPanResponder: () => false,
      // Only a clearly horizontal drag claims the gesture, so the list still scrolls vertically.
      onMoveShouldSetPanResponder: (_, g) =>
        !deletingRef.current && Math.abs(g.dx) > 10 && Math.abs(g.dx) > 2 * Math.abs(g.dy) && (resting.current !== 0 || g.dx < 0),
      onPanResponderGrant: () => {
        gestureStart.current = resting.current;
      },
      onPanResponderMove: (_, g) => {
        if (Math.abs(g.dx) > 10) swipeEmitter.open(swipeId);
        translateX.setValue(Math.max(-widthRef.current, Math.min(0, gestureStart.current + g.dx)));
      },
      onPanResponderRelease: (_, g) => {
        const outcome = swipeSettle(gestureStart.current, g.dx, widthRef.current);
        if (outcome === 'delete') runDelete();
        else snapTo(outcome === 'open' ? -SWIPE_OPEN_WIDTH : 0);
      },
      // The list (or the system) took the gesture: go back to the last settled position.
      onPanResponderTerminate: () => {
        if (!deletingRef.current) snapTo(gestureStart.current);
      },
    }),
  ).current;

  if (deleted) return null;

  return (
    <View style={styles.container}>
      {/* The red strip: starts at the row's right edge and moves with it, so it is off-screen
          (clipped) at rest and only ever fills the space the row has vacated. */}
      <Animated.View
        pointerEvents="none"
        style={[styles.strip, { width, backgroundColor: colors.danger, transform: [{ translateX }] }]}
      >
        <View style={styles.stripIcon}>{deleteActionComponent}</View>
      </Animated.View>
      {/* Stationary touch target over the revealed area (the row covers it until pulled aside). */}
      <Pressable style={styles.hit} onPress={runDelete} accessibilityRole="button" accessibilityLabel="Delete" />
      <Animated.View style={{ transform: [{ translateX }] }} {...panResponder.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    overflow: 'hidden',
  },
  strip: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: '100%',
    flexDirection: 'row',
  },
  stripIcon: {
    width: SWIPE_OPEN_WIDTH,
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  hit: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    width: SWIPE_OPEN_WIDTH,
  },
});
