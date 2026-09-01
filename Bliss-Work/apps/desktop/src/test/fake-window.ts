/**
 * A stand-in for Electron's BrowserWindow, for main-process tests.
 *
 * Records the constructor options it was given (`opts`) and every method call
 * in order (`calls`), so a test can assert on what the real code ASKED the OS
 * for — which is the only thing that can be checked without an Electron
 * runtime, and is exactly where the desktop-sticking regression lived (a note
 * built with `alwaysOnTop: false` and an owner window).
 *
 * Deliberately a hand-written double rather than a mock library: the surface is
 * small, and a test that reads `win.calls` is clearer about its claim than one
 * that reads a matcher chain.
 */
export class FakeWindow {
  static all: FakeWindow[] = [];

  opts: Record<string, unknown>;
  calls: Array<[string, ...unknown[]]> = [];
  listeners = new Map<string, Array<(...a: unknown[]) => void>>();

  private destroyed = false;
  private visible = false;
  private minimized = false;
  private bounds = { x: 0, y: 0, width: 360, height: 200 };

  webContents = {
    send: (...a: unknown[]) => this.calls.push(["webContents.send", ...a]),
    on: () => {},
    once: (event: string, cb: () => void) => {
      if (event === "did-finish-load") this.finishLoad = cb;
    },
    setWindowOpenHandler: () => {},
  };

  /** Held so a test can drive the load handshake deterministically. */
  finishLoad: (() => void) | null = null;

  constructor(opts: Record<string, unknown> = {}) {
    this.opts = opts;
    if (opts.alwaysOnTop) this.calls.push(["ctor:alwaysOnTop", true]);
    FakeWindow.all.push(this);
  }

  static reset(): void {
    FakeWindow.all = [];
  }

  /** Fire a window event the way Electron would. */
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }

  on(event: string, cb: (...a: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
    return this;
  }
  once(event: string, cb: (...a: unknown[]) => void): this {
    return this.on(event, cb);
  }

  setAlwaysOnTop(flag: boolean, level?: string): void {
    this.calls.push(["setAlwaysOnTop", flag, ...(level === undefined ? [] : [level])]);
  }
  showInactive(): void {
    this.visible = true;
    this.calls.push(["showInactive"]);
  }
  show(): void {
    this.visible = true;
    this.calls.push(["show"]);
  }
  hide(): void {
    this.visible = false;
    this.calls.push(["hide"]);
  }
  close(): void {
    this.destroyed = true;
    this.calls.push(["close"]);
  }
  destroy(): void {
    this.destroyed = true;
    this.calls.push(["destroy"]);
  }
  minimize(): void {
    this.minimized = true;
    this.calls.push(["minimize"]);
  }
  restore(): void {
    this.minimized = false;
    this.calls.push(["restore"]);
  }
  isVisible(): boolean {
    return this.visible;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  isMinimized(): boolean {
    return this.minimized;
  }
  isFocused(): boolean {
    return false;
  }
  getBounds() {
    return { ...this.bounds };
  }
  setBounds(b: Partial<typeof this.bounds>): void {
    this.bounds = { ...this.bounds, ...b };
    this.calls.push(["setBounds", { ...this.bounds }]);
  }
  setPosition(x: number, y: number): void {
    this.bounds.x = x;
    this.bounds.y = y;
    this.calls.push(["setPosition", x, y]);
  }
  setMinimumSize(w: number, h: number): void {
    this.calls.push(["setMinimumSize", w, h]);
  }
  setResizable(v: boolean): void {
    this.calls.push(["setResizable", v]);
  }
  setBackgroundColor(c: string): void {
    this.calls.push(["setBackgroundColor", c]);
  }
  setParentWindow(p: unknown): void {
    this.calls.push(["setParentWindow", p]);
  }
  setVisibleOnAllWorkspaces(v: boolean, o?: unknown): void {
    this.calls.push(["setVisibleOnAllWorkspaces", v, o]);
  }
  setContentProtection(v: boolean): void {
    this.calls.push(["setContentProtection", v]);
  }
  loadURL(): Promise<void> {
    return Promise.resolve();
  }
  loadFile(): Promise<void> {
    return Promise.resolve();
  }

  /** Did any call match this name (and, optionally, these args)? */
  called(name: string, ...args: unknown[]): boolean {
    return this.calls.some(
      ([n, ...a]) =>
        n === name &&
        args.every((want, i) => JSON.stringify(a[i]) === JSON.stringify(want)),
    );
  }
}

/** A 1920×1080 primary display, enough for every clamp path under test. */
export const fakeScreen = {
  getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
  on: () => {},
};
