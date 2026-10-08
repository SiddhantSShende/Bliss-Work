/**
 * Two ways a request used to hang for good:
 *  - the response HEADERS arrived (clearing the request timer) and the server then
 *    stalled mid-body, so `res.json()` never settled;
 *  - an upload's XHR had no `timeout` (its `ontimeout` handler was dead code), and
 *    its abort listener on the caller's signal was never removed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "./client";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("request body timeout", () => {
  const client = () =>
    new ApiClient({ taskBase: "http://task.test", getToken: async () => "tok", timeoutMs: 5_000 } as never);

  it("gives up with a 408 when the body stalls after the headers arrived", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => ({
        ok: true,
        status: 200,
        // Headers are in; the body never completes unless the request is aborted.
        json: () =>
          new Promise((_resolve, reject) =>
            init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
          ),
      })),
    );
    const pending = client().reassignTask("11111111-1111-4111-8111-111111111111").catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(5_000);

    const outcome = await Promise.race([pending, Promise.resolve("still hanging")]);
    expect(outcome).toBeInstanceOf(ApiError);
    expect(outcome).toMatchObject({ status: 408 });
  });

  it("does not leave the timer armed after a normal response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ taskId: "t", reassignedUserIds: [] }), { status: 200 })),
    );
    await client().reassignTask("11111111-1111-4111-8111-111111111111");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("uploadAttachment", () => {
  class FakeXhr {
    static last: FakeXhr;
    upload: { onprogress?: (e: unknown) => void; onload?: () => void } = {};
    onload?: () => void;
    onerror?: () => void;
    onabort?: () => void;
    ontimeout?: () => void;
    onloadend?: () => void;
    withCredentials = false;
    status = 0;
    responseText = "";
    aborted = false;
    constructor() {
      FakeXhr.last = this;
    }
    open() {}
    setRequestHeader() {}
    send() {}
    abort() {
      this.aborted = true;
      this.onabort?.();
      this.onloadend?.();
    }
    finish(status: number, body: unknown) {
      this.status = status;
      this.responseText = JSON.stringify(body);
      this.onload?.();
      this.onloadend?.();
    }
  }

  const upload = (signal?: AbortSignal, onProgress?: (a: number, b: number) => void) =>
    new ApiClient({ messagingBase: "http://msg.test", getToken: async () => "tok" } as never).uploadAttachment(
      "CONVERSATION" as never,
      "scope-1",
      new Blob(["x"]),
      { filename: "a.txt", signal, onProgress },
    );

  beforeEach(() => vi.stubGlobal("XMLHttpRequest", FakeXhr));

  it("fails with a 408 when no bytes move for the inactivity window", async () => {
    const p = upload().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(FakeXhr.last.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(FakeXhr.last.aborted).toBe(true);
    const err = await p;
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 408, message: "upload timed out" });
  });

  it("keeps a slow but moving upload alive, and still reports its progress", async () => {
    const onProgress = vi.fn();
    const p = upload(undefined, onProgress).catch((e: unknown) => e);
    for (let i = 1; i <= 5; i++) {
      await vi.advanceTimersByTimeAsync(50_000);
      FakeXhr.last.upload.onprogress?.({ lengthComputable: true, loaded: i, total: 5 });
    }
    expect(FakeXhr.last.aborted).toBe(false); // 250s in, but never silent for 60s
    expect(onProgress).toHaveBeenLastCalledWith(5, 5);

    FakeXhr.last.finish(500, { error: { message: "boom", code: "internal" } });
    expect(await p).toMatchObject({ status: 500, message: "boom" });
  });

  it("is a plain cancellation, not a timeout, when the caller aborts", async () => {
    const ctl = new AbortController();
    const p = upload(ctl.signal).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    ctl.abort();
    expect(await p).toMatchObject({ status: 0, message: "upload cancelled" });
  });

  it("releases its timer and its listener on the caller's signal when it finishes", async () => {
    const ctl = new AbortController();
    const remove = vi.spyOn(ctl.signal, "removeEventListener");
    const p = upload(ctl.signal).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    FakeXhr.last.finish(500, { error: { message: "boom" } });
    await p;

    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});
