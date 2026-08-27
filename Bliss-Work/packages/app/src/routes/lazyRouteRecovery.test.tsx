/**
 * End-to-end proof for the fix behind "meeting loads, then goes blank":
 * App.tsx's lazyRoute() races every route chunk against a timeout and, on
 * either a stall or an outright failure, self-heals via the same
 * reload-once mechanism chunkReloadRecovery.ts already uses for a stale
 * deploy — instead of leaving RouteFallback's blank div on screen forever.
 *
 * lazyRoute itself is a private helper inside App.tsx (not exported, and
 * rendering the full <App> tree to exercise one internal function would
 * mean standing up every provider/route it needs). This reproduces its
 * exact composition — withLoadTimeout + reloadForStaleChunk, real modules,
 * not mocks — against a stalled `import()`, which is the only untested seam
 * once those two pieces are independently proven (withLoadTimeout.test.ts,
 * chunkReloadRecovery.test.ts).
 */
import { Suspense, lazy } from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { withLoadTimeout } from "../lib/withLoadTimeout";
import { reloadForStaleChunk } from "../lib/chunkReloadRecovery";
import { ErrorBoundary } from "../features/ErrorBoundary";

function lazyRouteLike(load: () => Promise<{ default: () => null }>, timeoutMs: number) {
  return lazy(async () => {
    try {
      return await withLoadTimeout(load(), timeoutMs, "Timed out loading Route");
    } catch (e) {
      reloadForStaleChunk();
      throw e;
    }
  });
}

describe("lazyRoute-style chunk recovery", () => {
  let reloadSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    reloadSpy = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload: reloadSpy });
    // A rejected lazy import throws on render — RouteErrorBoundary is what
    // catches that in the real app; this silences the expected console.error
    // from ErrorBoundary.componentDidCatch logging it.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("self-heals a stalled route chunk instead of staying blank forever", async () => {
    const LazyRoute = lazyRouteLike(() => new Promise(() => {}), 15_000);

    render(
      <ErrorBoundary fallback={() => <div>error fallback</div>}>
        <Suspense fallback={<div>blank fallback</div>}>
          <LazyRoute />
        </Suspense>
      </ErrorBoundary>,
    );

    expect(reloadSpy).not.toHaveBeenCalled();
    // advanceTimersByTimeAsync flushes the microtasks between ticks, which is
    // what runs withLoadTimeout's rejection and this file's catch/reload —
    // no waitFor needed (and waitFor's own poll would itself be frozen by
    // the fake timers active here).
    await vi.advanceTimersByTimeAsync(15_000);

    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("does not reload for a chunk that loads normally", async () => {
    const LazyRoute = lazyRouteLike(async () => ({ default: () => null }), 15_000);
    render(
      <Suspense fallback={<div>blank fallback</div>}>
        <LazyRoute />
      </Suspense>,
    );

    await vi.advanceTimersByTimeAsync(15_000);
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});
