/**
 * Lags a boolean on both ends of a CSS transition, so a panel driven by plain
 * width/height utility classes can genuinely animate open and shut instead of
 * jump-cutting between "not in the DOM" and "fully sized".
 *
 * ── The two states, and why each needs its own lag ──────────────────────────
 * `open` alone can't drive a real transition: the instant it goes false, the
 * caller wants to stop rendering the panel — but an element that's gone from
 * the DOM has nothing left to animate. And the instant it goes true, mounting
 * straight at full size gives the browser nothing to grow FROM.
 *
 *  - `mounted` lags `open` on the way OUT — stays true for `durationMs` after
 *    `open` goes false, so there is still an element for the caller's
 *    "collapsed" size classes to shrink.
 *  - `entered` lags `open` on the way IN — starts false so the first paint
 *    after mounting is the collapsed size. Flipping it needs TWO nested
 *    `requestAnimationFrame`s, not one: rAF callbacks run before paint, so a
 *    single one can still land before the browser has painted the collapsed
 *    state even once, leaving nothing for the transition to animate from —
 *    it would just jump straight to open.
 */
import { useEffect, useRef, useState } from "react";

export function useCollapseTransition(open: boolean, durationMs: number) {
  const [mounted, setMounted] = useState(open);
  const [entered, setEntered] = useState(open);
  const enterRaf = useRef(0);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const raf1 = requestAnimationFrame(() => {
        enterRaf.current = requestAnimationFrame(() => setEntered(true));
      });
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(enterRaf.current);
      };
    }
    setEntered(false);
    const timeout = setTimeout(() => setMounted(false), durationMs);
    return () => clearTimeout(timeout);
  }, [open, durationMs]);

  return { mounted, entered };
}
