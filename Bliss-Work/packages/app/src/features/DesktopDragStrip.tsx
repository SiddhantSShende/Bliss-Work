import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useRuntime } from "../lib/runtime";
import { useTitleBarTheme } from "../lib/useTitleBarTheme";

const STRIP_HEIGHT = 48; // = MAIN_TITLE_BAR_HEIGHT in apps/desktop/src/main/windows.ts
const INTERACTIVE = "a,button,input,select,textarea,summary,[role=button],[contenteditable=true]";

/**
 * Desktop main window, screens WITHOUT the app shell (sign-in, onboarding, the
 * invite / join pages…). The OS title bar is hidden (see PlatformConfig.
 * windowControls), and TopNavbar — which normally is the header and the drag
 * handle — only exists under /app. Without this the native controls would float
 * over the page and the window could not be moved. Draws nothing: just a drag
 * region the height of the controls, and the colours they should use.
 */
export function DesktopDragStrip() {
  const { config } = useRuntime();
  const inShell = useLocation().pathname.startsWith("/app");
  return config.windowControls && !inShell ? <Strip side={config.windowControls.side} /> : null;
}

function Strip({ side }: { side: "left" | "right" }) {
  const swatch = useRef<HTMLSpanElement | null>(null);
  const strip = useRef<HTMLDivElement | null>(null);
  useTitleBarTheme(swatch);

  // A drag region swallows clicks on whatever is under it, so if a page's own
  // control ever sits in the strip (a short window scrolls a form up under it)
  // the strip gives up dragging until that control has moved out again.
  const [blocked, setBlocked] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => {
    let raf = 0;
    const check = () => {
      raf = 0;
      const own = strip.current?.getBoundingClientRect();
      if (!own) return;
      const hit = [...document.querySelectorAll(INTERACTIVE)].some((el) => {
        if (strip.current?.contains(el)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.top < STRIP_HEIGHT && r.bottom > 0 && r.left < own.right && r.right > own.left;
      });
      setBlocked(hit);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(check);
    };
    schedule();
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true); // capture: scrolling happens in inner containers too
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      mo.disconnect();
    };
  }, [pathname]);

  return (
    <div
      ref={strip}
      aria-hidden
      className={`${blocked ? "app-no-drag" : "app-drag app-titlebar"} pointer-events-none fixed inset-x-0 top-0 z-50 h-12`}
      style={
        side === "right"
          ? { right: "calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))" }
          : undefined
      }
    >
      {/* display:none still resolves styles — this only carries the bg/fg tokens. */}
      <span ref={swatch} className="hidden bg-bg text-fg" />
    </div>
  );
}
