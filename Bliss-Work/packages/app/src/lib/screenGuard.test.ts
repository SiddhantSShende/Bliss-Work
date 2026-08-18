import { describe, expect, it, vi, afterEach } from "vitest";
import { ATTEMPT_COALESCE_MS, captureChordOf, watchCaptureKeys } from "./screenGuard";

/**
 * The web half of screenshot detection. The desktop half has its own suite
 * (apps/desktop/src/main/screenshot-guard.test.ts) and the two chord tables are
 * meant to agree — an attempt reported under different names by the two hosts
 * would split one control into two in the activity record.
 */

afterEach(() => vi.useRealTimers());

describe("captureChordOf", () => {
  it("names the PrintScreen key, however the keymap spells it", () => {
    expect(captureChordOf({ key: "PrintScreen" })).toBe("PrintScreen");
    // Some Linux keymaps report the short form.
    expect(captureChordOf({ key: "Print" })).toBe("PrintScreen");
  });

  it("names the macOS capture chords", () => {
    expect(captureChordOf({ key: "3", metaKey: true, shiftKey: true })).toBe("Cmd+Shift+3");
    expect(captureChordOf({ key: "4", metaKey: true, shiftKey: true })).toBe("Cmd+Shift+4");
    expect(captureChordOf({ key: "5", metaKey: true, shiftKey: true })).toBe("Cmd+Shift+5");
  });

  it("ignores ordinary typing and near-misses", () => {
    for (const e of [
      { key: "a" },
      { key: "3" },
      { key: "3", shiftKey: true },
      { key: "3", metaKey: true },
      // Not a capture chord — Cmd+Shift+6 is nothing in particular, and warning
      // about it would teach people to ignore the warning.
      { key: "6", metaKey: true, shiftKey: true },
    ]) {
      expect(captureChordOf(e)).toBeNull();
    }
  });
});

describe("watchCaptureKeys", () => {
  const press = (init: KeyboardEventInit) => {
    const e = new KeyboardEvent("keydown", { ...init, cancelable: true, bubbles: true });
    window.dispatchEvent(e);
    return e;
  };

  it("reports an attempt and refuses the keystroke", () => {
    const onAttempt = vi.fn();
    const stop = watchCaptureKeys(onAttempt);

    const e = press({ key: "PrintScreen" });

    expect(onAttempt).toHaveBeenCalledWith("PrintScreen");
    // preventDefault stops the key reaching the page. It does NOT stop the OS,
    // which has already acted — the warning is the deliverable, not prevention.
    expect(e.defaultPrevented).toBe(true);
    stop();
  });

  it("coalesces a burst into one warning", () => {
    vi.useFakeTimers();
    const onAttempt = vi.fn();
    const stop = watchCaptureKeys(onAttempt);

    // PrintScreen auto-repeats while held; thirty toasts is not a warning.
    for (let i = 0; i < 5; i++) press({ key: "PrintScreen" });
    expect(onAttempt).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(ATTEMPT_COALESCE_MS + 1);
    press({ key: "PrintScreen" });
    expect(onAttempt).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stops listening once unsubscribed", () => {
    const onAttempt = vi.fn();
    watchCaptureKeys(onAttempt)();

    press({ key: "PrintScreen" });

    expect(onAttempt).not.toHaveBeenCalled();
  });

  it("leaves ordinary typing alone", () => {
    const onAttempt = vi.fn();
    const stop = watchCaptureKeys(onAttempt);

    const e = press({ key: "a" });

    expect(onAttempt).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
    stop();
  });
});
