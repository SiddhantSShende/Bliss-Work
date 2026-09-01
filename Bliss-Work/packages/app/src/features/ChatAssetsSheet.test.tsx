/**
 * The Docs tab's click routing, and the panel's own layout safety.
 *
 * Three things this pins down:
 *  - a previewable doc (PDF) opens the in-app Lightbox.
 *  - anything else is inert — never a link. It used to be `target="_blank"`,
 *    which looked like "open via the system/browser default" but the server
 *    forces `Content-Disposition: attachment` outside its own inline
 *    allowlist (media/mime.go), so that link silently downloaded the file.
 *    Same fix, same reasoning, as the inline chat bubble (MediaBubble.test.tsx).
 *  - the Lightbox it opens is NOT nested inside the Sheet's animated panel —
 *    it renders as a sibling. Sheet's panel carries a framer-motion transform
 *    even at rest, which becomes a new containing block for a `position:
 *    fixed` descendant; nesting Lightbox there would trap its full-screen
 *    backdrop inside the narrow sheet panel instead of covering the viewport.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatAssetsSheet } from "./ChatAssetsSheet";
import { encodeMedia, type MediaItem } from "../lib/chatEnvelope";

vi.mock("../lib/useAttachmentLinks", () => ({
  useAttachmentLinks: (ids: string[]) => ({
    urlFor: (id: string | undefined) => (id && ids.includes(id) ? `https://example.test/media/${id}` : undefined),
    isLoading: false,
    isResolved: true,
  }),
}));

const item = (over: Partial<MediaItem> & { id: string }): MediaItem => ({
  name: "file",
  size: 1024,
  mime: "application/octet-stream",
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderDocsTab(docItem: MediaItem) {
  render(
    <ChatAssetsSheet
      open
      onClose={vi.fn()}
      title="#general"
      messages={[{ id: "m1", body: encodeMedia([docItem]), senderName: "Ada" }]}
    />,
  );
  return screen.getByRole("tab", { name: /docs/i });
}

describe("ChatAssetsSheet Docs tab", () => {
  it("opens a PDF in the in-app Lightbox, rendered outside the sheet panel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("%PDF-1.4", { status: 200, headers: { "content-type": "application/pdf" } }),
      ),
    );
    const pdf = item({ id: "doc-1", name: "handbook.pdf", mime: "application/pdf" });
    const docsTab = renderDocsTab(pdf);
    await userEvent.click(docsTab);

    const row = screen.getByRole("button", { name: `Open ${pdf.name}` });
    await userEvent.click(row);

    const dialog = await screen.findByRole("dialog", { name: pdf.name });
    // The dialog's own panel is rendered directly under document.body's tree,
    // not inside the sheet's `role="dialog"` panel for the Docs list.
    expect(dialog.closest('[aria-label="#general"]')).toBeNull();
  });

  it("never downloads a non-previewable document — no link, just a clear message", async () => {
    const zip = item({ id: "doc-2", name: "archive.zip", mime: "application/zip" });
    const docsTab = renderDocsTab(zip);
    await userEvent.click(docsTab);

    expect(screen.queryByRole("link", { name: `Open ${zip.name}` })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: `Open ${zip.name}` })).not.toBeInTheDocument();
    expect(screen.getByText(zip.name)).toBeInTheDocument();
    expect(screen.getByText("Preview isn't available for this file type")).toBeInTheDocument();
  });
});
