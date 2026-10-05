import { useEffect, type RefObject } from "react";
import { useRuntime } from "./runtime";

/**
 * A CSS colour as `rgb(r, g, b)`. getComputedStyle normally returns that
 * already; newer syntaxes (`color(srgb …)` from color-mix, oklch) come back as
 * themselves and the native overlay may not parse them, so round-trip those
 * through a canvas, which always yields sRGB bytes.
 */
function toRgb(css: string): string {
  if (!css || /^rgba?\(/.test(css)) return css;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return css;
  ctx.fillStyle = "#000";
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Desktop only: keep the native window controls (drawn over the right edge of
 * the main window, see PlatformConfig.windowControls) in the colours of `ref`'s
 * element — its background and text colour. The theme is applied to <html>
 * (class + custom properties) by an effect that runs AFTER a child's, so watch
 * the attributes rather than read once.
 */
export function useTitleBarTheme(ref: RefObject<HTMLElement | null>) {
  const controls = useRuntime().config.windowControls;
  useEffect(() => {
    const el = ref.current;
    if (!controls || !el) return;
    let last = "";
    const sync = () => {
      const cs = getComputedStyle(el);
      const theme = { color: toRgb(cs.backgroundColor), symbolColor: toRgb(cs.color) };
      const key = `${theme.color}|${theme.symbolColor}`;
      if (key === last) return; // style churn on <html> is not a theme change
      last = key;
      controls.setTheme(theme);
    };
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    return () => mo.disconnect();
  }, [controls, ref]);
}
