/**
 * Lightbox's in-app document preview branch (PDF / plain text).
 *
 * Previously Lightbox only knew how to render images and video — there was no
 * in-app viewer for a shared document at all, so every "supported" doc type
 * had to leave the app to be seen. This covers the DocFrame branch added to
 * fix that: fetch the signed URL into a blob, show it in an <iframe>, and
 * degrade to an "open elsewhere" link if the fetch fails.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Lightbox } from "./Lightbox";
import type { MediaItem } from "../lib/chatEnvelope";

const PDF: MediaItem = {
  id: "doc-1",
  name: "handbook.pdf",
  size: 2048,
  mime: "application/pdf",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Lightbox document preview", () => {
  it("renders the fetched document in an iframe once the preview loads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("%PDF-1.4", { status: 200, headers: { "content-type": "application/pdf" } }),
      ),
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-pdf");

    render(
      <Lightbox
        items={[PDF]}
        index={0}
        urlFor={() => "https://example.test/media/doc-1?t=sig"}
        onClose={vi.fn()}
        onIndexChange={vi.fn()}
      />,
    );

    const frame = await screen.findByTitle(PDF.name);
    expect(frame.tagName).toBe("IFRAME");
    expect(frame).toHaveAttribute("src", "blob:mock-pdf");
  });

  it("falls back to an external open link when the preview fails to load", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));

    render(
      <Lightbox
        items={[PDF]}
        index={0}
        urlFor={() => "https://example.test/media/doc-1?t=sig"}
        onClose={vi.fn()}
        onIndexChange={vi.fn()}
      />,
    );

    const fallback = await screen.findByRole("link", { name: "Open in browser instead" });
    await waitFor(() => expect(fallback).toHaveAttribute("href", "https://example.test/media/doc-1?t=sig"));
    expect(fallback).toHaveAttribute("target", "_blank");
  });
});
