import { describe, expect, it, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useBlobUrl } from "./useBlobUrl";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useBlobUrl", () => {
  it("starts loading and resolves to an object URL on a successful fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("hello", { status: 200, headers: { "content-type": "text/plain" } }),
      ),
    );
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-url");

    const { result } = renderHook(() => useBlobUrl("https://example.test/media/1?t=abc"));

    expect(result.current.isLoading).toBe(true);
    expect(result.current.url).toBeUndefined();

    await waitFor(() => expect(result.current.url).toBe("blob:mock-url"));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeUndefined();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("surfaces an error and never resolves a URL when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));

    const { result } = renderHook(() => useBlobUrl("https://example.test/media/1?t=expired"));

    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.url).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });

  it("surfaces an error on a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const { result } = renderHook(() => useBlobUrl("https://example.test/media/1"));

    await waitFor(() => expect(result.current.error).toBe("network down"));
  });

  it("does nothing while the source is undefined", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useBlobUrl(undefined));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.url).toBeUndefined();
  });

  it("revokes the object URL on unmount", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("hello", { status: 200, headers: { "content-type": "text/plain" } }),
      ),
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-url");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const { result, unmount } = renderHook(() => useBlobUrl("https://example.test/media/1"));
    await waitFor(() => expect(result.current.url).toBe("blob:mock-url"));

    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });
});
