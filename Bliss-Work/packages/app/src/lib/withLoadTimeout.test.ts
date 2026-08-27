import { describe, expect, it, vi } from "vitest";
import { withLoadTimeout } from "./withLoadTimeout";

describe("withLoadTimeout", () => {
  it("resolves normally when the promise settles before the deadline", async () => {
    await expect(withLoadTimeout(Promise.resolve("ok"), 1_000, "timed out")).resolves.toBe("ok");
  });

  it("rejects with the original error when the promise rejects before the deadline", async () => {
    await expect(
      withLoadTimeout(Promise.reject(new Error("boom")), 1_000, "timed out"),
    ).rejects.toThrow("boom");
  });

  it("rejects with the timeout message when the promise never settles", async () => {
    vi.useFakeTimers();
    const never = new Promise(() => {});
    const result = withLoadTimeout(never, 1_000, "timed out waiting");
    const assertion = expect(result).rejects.toThrow("timed out waiting");
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    vi.useRealTimers();
  });

  it("does not fire the timeout once the promise has already resolved", async () => {
    vi.useFakeTimers();
    const result = withLoadTimeout(Promise.resolve("fast"), 1_000, "timed out");
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toBe("fast");
    // Advancing well past the deadline must not turn a settled promise into
    // a rejection — the internal timer has to actually be cleared.
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toBe("fast");
    vi.useRealTimers();
  });
});
