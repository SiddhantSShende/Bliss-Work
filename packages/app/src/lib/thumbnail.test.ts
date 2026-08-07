import { afterEach, describe, expect, it, vi } from "vitest";
import { makeThumbnail } from "./thumbnail";

/**
 * A thumbnail is an optimisation. The upload path AWAITS it, so every failure
 * mode here has to end in "no poster, carry on" — never a rejection and never a
 * pending promise, either of which stops the send with no error shown.
 */

function blob(type: string): Blob & { name?: string } {
  return Object.assign(new Blob(["x"], { type }), { name: "f" });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("makeThumbnail", () => {
  it("returns no poster for a non-visual file instead of throwing", async () => {
    await expect(makeThumbnail(blob("application/pdf"))).resolves.toEqual({
      thumb: null,
      dimensions: {},
    });
  });

  it("degrades to no poster when the decoder rejects", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("bad image")));
    const r = await makeThumbnail(blob("image/png"));
    expect(r.thumb).toBeNull();
  });

  it("degrades to no poster when createImageBitmap is unavailable", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    const r = await makeThumbnail(blob("image/png"));
    expect(r.thumb).toBeNull();
  });

  // The regression that matters: a decoder that never settles must not hang the
  // send. Before the timeout, this promise pended forever and the user saw a
  // file picker close and then absolutely nothing happen.
  it("gives up on a decoder that never settles", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise(() => {})));

    const pending = makeThumbnail(blob("image/png"));
    let settled = false;
    void pending.then(() => (settled = true));

    await vi.advanceTimersByTimeAsync(9_000);
    expect(settled).toBe(false); // still within the budget

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual({ thumb: null, dimensions: {} });
  });
});
