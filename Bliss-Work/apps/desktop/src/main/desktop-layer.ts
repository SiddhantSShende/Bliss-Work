import type { BrowserWindow } from "electron";

/**
 * Windows only: keep the pinned task note on the DESKTOP layer — above the
 * wallpaper and icons, below every ordinary application window.
 *
 * Electron has no API for that. `alwaysOnTop: false` alone leaves the note at
 * the ordinary z-order, where the next application the user clicks buries it,
 * and `alwaysOnTop: true` floats it over everything. What does work is a Win32
 * `SetWindowPos` that inserts the note directly above the window hosting the
 * desktop icons, which sits at the bottom of the top-level z-order. The note
 * stays a normal top-level window, so dragging, resizing, geometry persistence
 * and content protection are unaffected.
 *
 * The placement is re-applied on a short timer rather than on a list of OS
 * events: Explorer restarting (new desktop window), Show Desktop, unlocking the
 * session and a display change can all disturb it, and one idempotent call every
 * couple of seconds covers all of them.
 *
 * `koffi` ships a prebuilt user32 bridge, so nothing is compiled. Every failure
 * (no koffi, an API that will not bind, a rejected call) leaves the note as the
 * plain non-topmost window it already is.
 */

const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const REASSERT_INTERVAL_MS = 2_000;
/** Upper bound on WorkerW windows walked while looking for the icon host. */
const MAX_WORKERW_SCAN = 64;

export interface DesktopNative {
  /** The top-level window hosting the desktop icons, or 0 when none is found. */
  desktopHost(): number;
  /** Put `hwnd` directly above `after` in the z-order, without activating it. */
  placeAbove(hwnd: number, after: number): void;
}

interface Koffi {
  load(library: string): { func(prototype: string): (...args: unknown[]) => unknown };
}

let native: Promise<DesktopNative | null> | null = null;

/** Bind the three user32 calls, once. Null when koffi or a binding is unavailable. */
export function loadDesktopNative(): Promise<DesktopNative | null> {
  native ??= (async () => {
    try {
      // A variable specifier keeps the bundler from inlining a native addon (same
      // pattern as get-windows in foreground.ts). koffi is CommonJS, so the
      // callable API is on `default`. The result is typed by the three calls
      // bound below — an unexpected shape throws here and is caught.
      const specifier = "koffi";
      const imported = (await import(/* @vite-ignore */ specifier)) as { default?: Koffi } & Koffi;
      const user32 = (imported.default ?? imported).load("user32.dll");
      const findWindow = user32.func("intptr_t __stdcall FindWindowW(str16 className, str16 windowName)");
      const findWindowEx = user32.func(
        "intptr_t __stdcall FindWindowExW(intptr_t parent, intptr_t after, str16 className, str16 windowName)",
      );
      const setWindowPos = user32.func(
        "bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)",
      );
      const hostsIcons = (w: number) => Number(findWindowEx(w, 0, "SHELLDLL_DefView", null)) !== 0;
      return {
        // Progman hosts the icons until a wallpaper slideshow (or a live-wallpaper
        // app) moves them into a WorkerW that sits above it — place above whichever
        // holds them so the note is never under the icon layer.
        desktopHost() {
          const progman = Number(findWindow("Progman", null));
          if (progman !== 0 && hostsIcons(progman)) return progman;
          let worker = 0;
          for (let i = 0; i < MAX_WORKERW_SCAN; i++) {
            worker = Number(findWindowEx(0, worker, "WorkerW", null));
            if (worker === 0) break;
            if (hostsIcons(worker)) return worker;
          }
          return progman;
        },
        placeAbove: (hwnd, after) => {
          setWindowPos(hwnd, after, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
        },
      };
    } catch (err) {
      console.warn("[desktop-layer] unavailable, notes stay at normal z-order:", err instanceof Error ? err.message : err);
      return null;
    }
  })();
  return native;
}

function handleOf(win: BrowserWindow): number {
  const buf = win.getNativeWindowHandle();
  return Number(buf.length >= 8 ? buf.readBigUInt64LE(0) : buf.readUInt32LE(0));
}

/** Attach the note to the desktop layer for as long as the window lives. */
export function attachToDesktopLayer(win: BrowserWindow, load = loadDesktopNative): void {
  void load().then((api) => {
    if (!api || win.isDestroyed()) return;
    const hwnd = handleOf(win);
    let timer: ReturnType<typeof setInterval> | undefined;

    const place = () => {
      if (win.isDestroyed() || !win.isVisible()) return;
      try {
        // A missing desktop window or a refused call is transient (Explorer is
        // restarting, the session is locked): the next tick simply tries again.
        const host = api.desktopHost();
        if (host !== 0) api.placeAbove(hwnd, host);
      } catch (err) {
        // A binding that throws will keep throwing — stop, leave the note at its
        // normal z-order, and don't log once every two seconds.
        console.warn("[desktop-layer] placement failed, giving up:", err instanceof Error ? err.message : err);
        win.off("show", place);
        if (timer) clearInterval(timer);
      }
    };

    win.on("show", place);
    win.once("closed", () => clearInterval(timer));
    timer = setInterval(place, REASSERT_INTERVAL_MS);
    place();
  });
}
