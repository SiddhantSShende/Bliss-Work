import { useEffect, useState, type RefObject } from "react";

/**
 * The width ÷ height of the picture a <video> is actually showing, or null
 * before it has one (no stream yet, or metadata not loaded).
 *
 * Read from the element rather than from the stream's track settings so it is
 * what is on screen — including a camera that changes mode mid-stream, which
 * fires `resize` on the element.
 */
export function useVideoAspect(ref: RefObject<HTMLVideoElement | null>): number | null {
  const [aspect, setAspect] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const { videoWidth, videoHeight } = el;
      setAspect(videoWidth > 0 && videoHeight > 0 ? videoWidth / videoHeight : null);
    };
    read();
    el.addEventListener("loadedmetadata", read);
    el.addEventListener("resize", read);
    return () => {
      el.removeEventListener("loadedmetadata", read);
      el.removeEventListener("resize", read);
    };
  }, [ref]);
  return aspect;
}
