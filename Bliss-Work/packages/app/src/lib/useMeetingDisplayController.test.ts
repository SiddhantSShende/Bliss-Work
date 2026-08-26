/**
 * The controller's own state-machine correctness, independent of CallRoom's
 * giant render tree. userBehaviorAnalysis is used for real here (not
 * mocked) — it's cheap, deterministic, and exercising the real
 * visibilitychange/blur/focus wiring is exactly what proves this controller
 * is actually connected to it rather than to a private listener of its own.
 * `pip` is a hand-built double shaped like MeetingPiPApi, since
 * useMeetingPiP's OWN correctness (the browser mechanics) is covered on its
 * own terms in useMeetingPiP.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { MeetingPiPApi } from "./useMeetingPiP";
import {
  useMeetingDisplayController,
  type MeetingDisplaySession,
} from "./useMeetingDisplayController";

function fakePip(over: Partial<MeetingPiPApi> = {}): MeetingPiPApi {
  return {
    supported: true,
    active: false,
    toggle: vi.fn(),
    enter: vi.fn(async () => true),
    exit: vi.fn(async () => {}),
    ...over,
  };
}

function fakeSession(minimized = false): MeetingDisplaySession {
  return { minimized, minimize: vi.fn(), restore: vi.fn() };
}

function hide() {
  Object.defineProperty(document, "hidden", { value: true, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}
function show() {
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
});
afterEach(() => {
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
});

describe("mode", () => {
  it("is NORMAL when neither PiP nor minimize is active", () => {
    const { result } = renderHook(() =>
      useMeetingDisplayController(fakeSession(false), fakePip({ active: false }), true),
    );
    expect(result.current.mode).toBe("NORMAL");
  });

  it("is MINIMIZED when the session says so and PiP is not active", () => {
    const { result } = renderHook(() =>
      useMeetingDisplayController(fakeSession(true), fakePip({ active: false }), true),
    );
    expect(result.current.mode).toBe("MINIMIZED");
  });

  it("is PICTURE_IN_PICTURE whenever PiP is active, even if the session also says minimized", () => {
    // Should not normally coexist — this is exactly the invariant the mode
    // computation exists to protect: PiP always wins the READ, regardless of
    // what the underlying session flag happens to say at this instant.
    const { result } = renderHook(() =>
      useMeetingDisplayController(fakeSession(true), fakePip({ active: true }), true),
    );
    expect(result.current.mode).toBe("PICTURE_IN_PICTURE");
  });
});

describe("USER_AWAY → attempt PiP → success", () => {
  it("does not fall back to minimize when PiP is granted", async () => {
    const session = fakeSession(false);
    const pip = fakePip({ enter: vi.fn(async () => true) });
    renderHook(() => useMeetingDisplayController(session, pip, true));

    await act(async () => {
      hide();
      await Promise.resolve();
    });

    expect(pip.enter).toHaveBeenCalledTimes(1);
    expect(session.minimize).not.toHaveBeenCalled();
  });

  it("drops out of an existing minimize once PiP succeeds", async () => {
    const session = fakeSession(true);
    const pip = fakePip({ enter: vi.fn(async () => true) });
    renderHook(() => useMeetingDisplayController(session, pip, true));

    await act(async () => {
      hide();
      await Promise.resolve();
    });

    expect(session.restore).toHaveBeenCalledTimes(1);
  });
});

describe("USER_AWAY → attempt PiP → failure → fallback", () => {
  it("minimizes when PiP is refused (no user gesture, unsupported, or no track)", async () => {
    const session = fakeSession(false);
    const pip = fakePip({ enter: vi.fn(async () => false) });
    renderHook(() => useMeetingDisplayController(session, pip, true));

    await act(async () => {
      hide();
      await Promise.resolve();
    });

    expect(pip.enter).toHaveBeenCalledTimes(1);
    expect(session.minimize).toHaveBeenCalledTimes(1);
  });

  it("does not re-minimize when already minimized — nothing to change", async () => {
    const session = fakeSession(true);
    const pip = fakePip({ enter: vi.fn(async () => false) });
    renderHook(() => useMeetingDisplayController(session, pip, true));

    await act(async () => {
      hide();
      await Promise.resolve();
    });

    expect(session.minimize).not.toHaveBeenCalled();
  });

  it("stays NORMAL and the meeting keeps running when neither PiP nor minimize is available", async () => {
    const pip = fakePip({ enter: vi.fn(async () => false) });
    renderHook(() => useMeetingDisplayController(null, pip, true));

    await expect(
      act(async () => {
        hide();
        await Promise.resolve();
      }),
    ).resolves.not.toThrow();
  });
});

describe("USER_RETURNED", () => {
  it("exits PiP and restores NORMAL when the away episode auto-minimised as a fallback", async () => {
    const session = fakeSession(false);
    const pip = fakePip({ enter: vi.fn(async () => false) });
    renderHook(() => useMeetingDisplayController(session, pip, true));

    await act(async () => {
      hide();
      await Promise.resolve();
    });
    expect(session.minimize).toHaveBeenCalledTimes(1);

    await act(async () => {
      show();
      await Promise.resolve();
    });
    expect(pip.exit).toHaveBeenCalledTimes(1);
    expect(session.restore).toHaveBeenCalledTimes(1);
  });

  it("restores back into MINIMIZED — not NORMAL — when the user was already minimised before going away", async () => {
    const session = fakeSession(true);
    const pip = fakePip({ enter: vi.fn(async () => false) });
    renderHook(() => useMeetingDisplayController(session, pip, true));

    await act(async () => {
      hide();
      await Promise.resolve();
    });
    session.minimize = vi.fn(); // reset — asserted not-called above

    await act(async () => {
      show();
      await Promise.resolve();
    });
    expect(session.minimize).toHaveBeenCalledTimes(1);
    expect(session.restore).not.toHaveBeenCalled();
  });

  it("does nothing when the meeting was already NORMAL the whole time", async () => {
    const pip = fakePip();
    // No hide/show at all — nothing should fire.
    const session = fakeSession(false);
    renderHook(() => useMeetingDisplayController(session, pip, true));
    await act(async () => {
      show(); // a spurious focus with no matching away first
      await Promise.resolve();
    });
    expect(pip.exit).not.toHaveBeenCalled();
    expect(session.minimize).not.toHaveBeenCalled();
    expect(session.restore).not.toHaveBeenCalled();
  });
});

describe("repeated away/return events do not corrupt state or duplicate work", () => {
  it("USER_AWAY USER_AWAY USER_AWAY USER_RETURNED USER_RETURNED USER_AWAY settles correctly", async () => {
    const session = fakeSession(false);
    const pip = fakePip({ enter: vi.fn(async () => false) });
    renderHook(() => useMeetingDisplayController(session, pip, true));

    await act(async () => {
      hide();
      hide();
      hide();
      await Promise.resolve();
    });
    // userBehaviorAnalysis's own dedup collapses the repeats into one away.
    expect(pip.enter).toHaveBeenCalledTimes(1);
    expect(session.minimize).toHaveBeenCalledTimes(1);

    await act(async () => {
      show();
      show();
      await Promise.resolve();
    });
    expect(pip.exit).toHaveBeenCalledTimes(1);
    expect(session.restore).toHaveBeenCalledTimes(1);

    await act(async () => {
      hide();
      await Promise.resolve();
    });
    expect(pip.enter).toHaveBeenCalledTimes(2);
    expect(session.minimize).toHaveBeenCalledTimes(2);
  });
});

describe("PiP engaging outside the away flow (native autopictureinpicture)", () => {
  it("still drops out of minimize the instant pip.active becomes true", () => {
    const session = fakeSession(false);
    const pip = fakePip({ active: false });
    const { rerender } = renderHook(
      ({ pip: p }) => useMeetingDisplayController(session, p, true),
      { initialProps: { pip } },
    );

    session.minimized = true;
    rerender({ pip });
    expect(session.restore).not.toHaveBeenCalled();

    const activePip = fakePip({ active: true });
    rerender({ pip: activePip });
    expect(session.restore).toHaveBeenCalledTimes(1);
  });
});

describe("manual minimise while PiP is active", () => {
  it("exits PiP before minimising", async () => {
    const session = fakeSession(false);
    const pip = fakePip({ active: true });
    const { result } = renderHook(() => useMeetingDisplayController(session, pip, true));

    await act(async () => {
      result.current.handleMinimize();
      await Promise.resolve();
    });

    expect(pip.exit).toHaveBeenCalledTimes(1);
    expect(session.minimize).toHaveBeenCalledTimes(1);
  });

  it("does nothing destructive when there is no session to minimise into", () => {
    const pip = fakePip({ active: true });
    const { result } = renderHook(() => useMeetingDisplayController(null, pip, true));
    expect(() => result.current.handleMinimize()).not.toThrow();
    expect(pip.exit).not.toHaveBeenCalled();
  });
});

describe("disabled", () => {
  it("does not react to away/return signals at all", async () => {
    const session = fakeSession(false);
    const pip = fakePip();
    renderHook(() => useMeetingDisplayController(session, pip, false));

    await act(async () => {
      hide();
      await Promise.resolve();
    });
    expect(pip.enter).not.toHaveBeenCalled();
    expect(session.minimize).not.toHaveBeenCalled();
  });
});
