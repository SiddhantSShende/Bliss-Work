import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useAttachmentLinks } from "./useAttachmentLinks";

const api = vi.hoisted(() => ({
  attachmentLinks: vi.fn(async (ids: string[]) => ids.map((id) => ({ id, url: `/media/${id}` }))),
  mediaUrl: vi.fn((path: string) => `https://media.test${path}`),
}));

vi.mock("./runtime", () => ({ useRuntime: () => ({ api }) }));

function wrapper({ children }: { children: ReactNode }) {
  return createElement(
    QueryClientProvider,
    { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
    children,
  );
}

describe("useAttachmentLinks", () => {
  it("does not request links for an empty list", async () => {
    api.attachmentLinks.mockClear();
    const { result } = renderHook(() => useAttachmentLinks([]), { wrapper });

    await waitFor(() => expect(result.current.isResolved).toBe(true));
    expect(api.attachmentLinks).not.toHaveBeenCalled();
  });

  it("uses one request for up to 50 unique ids", async () => {
    api.attachmentLinks.mockClear();
    const ids = Array.from({ length: 50 }, (_, index) => `id-${index}`);
    renderHook(() => useAttachmentLinks(ids), { wrapper });

    await waitFor(() => expect(api.attachmentLinks).toHaveBeenCalledTimes(1));
    expect(api.attachmentLinks).toHaveBeenCalledWith([...ids].sort());
  });

  it("chunks larger lists, removes duplicates, and maps every response", async () => {
    api.attachmentLinks.mockClear();
    const ids = [...Array.from({ length: 101 }, (_, index) => `id-${index}`), "id-50"];
    const { result } = renderHook(() => useAttachmentLinks(ids), { wrapper });

    await waitFor(() => expect(result.current.isResolved).toBe(true));
    expect(api.attachmentLinks).toHaveBeenCalledTimes(3);
    expect(api.attachmentLinks.mock.calls.map(([chunk]) => chunk.length)).toEqual([50, 50, 1]);
    expect(result.current.urlFor("id-100")).toBe("https://media.test/media/id-100");
  });
});