import { win32 } from "node:path";

/**
 * Windows only: one-shot snapshot of which application is in front.
 *
 * Reads exactly three things — the foreground window's owning process, that
 * process's executable path, and the executable's file name. It deliberately
 * never touches the window title, its contents, input, the clipboard or the
 * screen: the only Win32 calls bound are the five below, and none of them can
 * reach any of that.
 *
 *   user32!GetForegroundWindow          which top-level window is in front
 *   user32!GetWindowThreadProcessId     which process owns it
 *   kernel32!OpenProcess                a limited-rights handle to that process
 *   kernel32!QueryFullProcessImageNameW the handle's executable path
 *   kernel32!CloseHandle                released again, always
 *
 * This is a snapshot, not a sampler: polling, spans and idle belong to the
 * caller. Every failure (no koffi, a binding that will not resolve, no window
 * in front, an elevated or already-exited process) degrades to `null` rather
 * than throwing, and off Windows the loader returns null without importing
 * anything — so nothing here can take the app down.
 *
 * Loaded the same way as desktop-layer.ts: `koffi` is imported dynamically so
 * the bundler never inlines a native addon, and the loader is injectable so the
 * Win32 behaviour can be tested without Windows.
 */

/** Enough to ask for an image path; granted for most processes, even elevated ones in the same session. */
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
/** The longest path Win32 will hand back, in UTF-16 code units. */
const MAX_PATH_CHARS = 32_768;

export interface ForegroundApp {
  /** Executable file name as Windows reports it, e.g. `chrome.exe`. */
  name: string;
  /** Full executable path, e.g. `C:\Program Files\Google\Chrome\Application\chrome.exe`. */
  path: string;
  /** The caller's timestamp for this snapshot, echoed back untouched. */
  at: number;
}

export interface ForegroundNative {
  /** Handle of the window in front, or 0 when there is none. */
  foregroundWindow(): number;
  /** Id of the process owning `hwnd`, or 0 when it cannot be determined. */
  processIdOf(hwnd: number): number;
  /** Executable path of `pid`, or null if it cannot be opened (elevated), has exited, or is not queryable. */
  imagePathOf(pid: number): string | null;
}

type Fn = (...args: unknown[]) => unknown;
interface Koffi {
  load(library: string): { func(prototype: string): Fn };
}

let native: Promise<ForegroundNative | null> | null = null;

/** Bind the five Win32 calls. Throws if any will not resolve — callers go through `loadForegroundNative`. */
export function bindForegroundNative(koffi: Koffi): ForegroundNative {
  const user32 = koffi.load("user32.dll");
  const kernel32 = koffi.load("kernel32.dll");
  const getForegroundWindow = user32.func("intptr_t __stdcall GetForegroundWindow()");
  const getWindowThreadProcessId = user32.func(
    "uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32_t *pid)",
  );
  const openProcess = kernel32.func("intptr_t __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)");
  const queryImageName = kernel32.func(
    "bool __stdcall QueryFullProcessImageNameW(intptr_t process, uint32_t flags, _Out_ uint16_t *name, _Inout_ uint32_t *size)",
  );
  const closeHandle = kernel32.func("bool __stdcall CloseHandle(intptr_t handle)");
  // One buffer for every snapshot: calls are synchronous, so it is never shared.
  const buffer = new Uint16Array(MAX_PATH_CHARS);

  return {
    foregroundWindow: () => Number(getForegroundWindow()),
    processIdOf(hwnd) {
      const pid = [0];
      getWindowThreadProcessId(hwnd, pid);
      return pid[0] ?? 0;
    },
    imagePathOf(pid) {
      const handle = Number(openProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid));
      if (handle === 0) return null; // access denied (elevated) or the process is already gone
      try {
        const size = [MAX_PATH_CHARS];
        if (!queryImageName(handle, 0, buffer, size)) return null;
        const length = size[0] ?? 0;
        if (length === 0) return null;
        // The path is NUL-terminated inside the buffer: cut there so a length that
        // was not written back can never leak the buffer's stale tail.
        const path = Buffer.from(buffer.buffer, 0, length * 2).toString("utf16le").split("\0", 1)[0];
        return path || null;
      } finally {
        closeHandle(handle);
      }
    },
  };
}

/** Bind the Win32 calls, once. Null off Windows, or when koffi or a binding is unavailable. */
export function loadForegroundNative(): Promise<ForegroundNative | null> {
  native ??= (async () => {
    if (process.platform !== "win32") return null;
    try {
      // A variable specifier keeps the bundler from inlining a native addon. koffi
      // is CommonJS, so the callable API is on `default`.
      const specifier = "koffi";
      const imported = (await import(/* @vite-ignore */ specifier)) as { default?: Koffi } & Koffi;
      return bindForegroundNative(imported.default ?? imported);
    } catch (err) {
      console.warn("[foreground-win32] unavailable:", err instanceof Error ? err.message : err);
      return null;
    }
  })();
  return native;
}

/**
 * Which application is in front right now, stamped with the caller's `at`.
 * Null when nothing usable is in front or the platform cannot say. Never throws.
 */
export async function getForegroundApp(
  at: number,
  load: () => Promise<ForegroundNative | null> = loadForegroundNative,
): Promise<ForegroundApp | null> {
  try {
    const api = await load();
    if (!api) return null;
    const hwnd = api.foregroundWindow();
    if (hwnd === 0) return null; // no window in front: lock screen, UAC prompt, desktop switching
    const pid = api.processIdOf(hwnd);
    if (pid === 0) return null;
    const path = api.imagePathOf(pid);
    if (!path) return null;
    const name = win32.basename(path);
    return name ? { name, path, at } : null;
  } catch {
    // A transient failure on one snapshot is not an error; the next one simply tries again.
    return null;
  }
}
