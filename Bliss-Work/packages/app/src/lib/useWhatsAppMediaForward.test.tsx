/**
 * The media half of a WhatsApp forward falls back to saving the files when the
 * browser has no share sheet. The object URL it saves from must outlive the
 * click: revoking it synchronously after `a.click()` can cancel the download
 * before the browser has begun reading it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  api: {
    attachmentLinks: vi.fn(async (ids: string[]) => ids.map((id) => ({ id, url: `/m/${id}` }))),
    mediaUrl: (p: string) => `https://files.test${p}`,
  },
}));
vi.mock("./runtime", () => ({ useRuntime: () => ({ api: h.api }) }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

import { useWhatsAppMediaForward } from "./useWhatsAppMediaForward";

let created: string[];
let revoked: string[];

beforeEach(() => {
  created = [];
  revoked = [];
  vi.stubGlobal("URL", Object.assign(URL, {
    createObjectURL: () => {
      const u = `blob:app/${created.length + 1}`;
      created.push(u);
      return u;
    },
    revokeObjectURL: (u: string) => void revoked.push(u),
  }));
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => new Blob(["x"]) })));
  // No share sheet: the hook must fall back to downloading.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useWhatsAppMediaForward download fallback", () => {
  it("does not revoke the object URL until the download has had time to start", async () => {
    // Capture only the long (revoke-delay) timer; everything else runs normally.
    const longTimers: Array<() => void> = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      if (ms !== undefined && ms >= 5_000) {
        longTimers.push(fn);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout);

    const { result } = renderHook(() => useWhatsAppMediaForward());
    act(() => result.current([{ id: "a1", name: "pic.png", mime: "image/png" }]));
    await waitFor(() => expect(created).toHaveLength(1));

    // click() has happened; the browser has not necessarily started reading yet.
    expect(revoked).toEqual([]);

    // Later, it is released.
    expect(longTimers).toHaveLength(1);
    longTimers[0]!();
    expect(revoked).toEqual(created);
  });
});
