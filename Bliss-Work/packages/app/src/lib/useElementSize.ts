import { useLayoutEffect, useRef, useState } from "react";

export interface ElementSize {
  width: number;
  height: number;
}

/**
 * The laid-out size of an element, kept current as it resizes.
 *
 * `null` until the first measurement, which happens before paint (a layout
 * effect), so a caller that renders nothing while it is null never shows a
 * frame of the wrong size. Uses clientWidth/clientHeight — the box the layout
 * gave the element — so a CSS transform mid-animation does not read as a resize.
 *
 * The measured element must get its size from ITS PARENT (flex/grid/absolute),
 * never from its own children: an element whose content decides its size, and
 * whose content is decided by its size, never settles.
 */
export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<ElementSize | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      setSize((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, size] as const;
}
