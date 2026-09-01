/**
 * FileCard — the non-image/video attachment inside a chat bubble.
 *
 * Two generations of regression coverage live here: FileCard used to render
 * as an inert `<div>` with no href and no click handler at all, so a shared
 * PDF could not be opened from the bubble itself (only from the separate
 * "Media, Links & Docs" panel) — fixed by opening previewable types in-app.
 * It THEN used `target="_blank"` for everything else, which looked like an
 * "Open" action but was actually a download: the server forces
 * `Content-Disposition: attachment` for every type outside its own inline
 * allowlist (media/mime.go), so that link silently downloaded the file
 * instead of opening it anywhere. There is no fallback to downloading now —
 * an unsupported type renders an inert tile that says so.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MediaBubble } from "./MediaBubble";
import type { MediaItem } from "../lib/chatEnvelope";

function fileItem(over: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "att-1",
    name: "report.pdf",
    size: 1024,
    mime: "application/pdf",
    ...over,
  };
}

describe("MediaBubble FileCard", () => {
  it("opens the in-app preview for a PDF instead of leaving the app", async () => {
    const onOpen = vi.fn();
    const item = fileItem();
    render(
      <MediaBubble
        items={[item]}
        mine={false}
        urlFor={() => "https://example.test/media/att-1?t=sig"}
        isResolved
        onOpen={onOpen}
      />,
    );

    const card = screen.getByRole("button", { name: `Open ${item.name}` });
    await userEvent.click(card);
    expect(onOpen).toHaveBeenCalledWith(0);
  });

  it("never downloads an unsupported document type — no link, just a clear message", () => {
    const item = fileItem({ id: "att-2", name: "archive.zip", mime: "application/zip" });
    render(
      <MediaBubble
        items={[item]}
        mine={false}
        urlFor={() => "https://example.test/media/att-2?t=sig"}
        isResolved
        onOpen={vi.fn()}
      />,
    );

    // No <a>, no <button> — nothing clicking it could do, on either platform.
    expect(screen.queryByRole("link", { name: `Open ${item.name}` })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: `Open ${item.name}` })).not.toBeInTheDocument();
    expect(screen.getByText(item.name)).toBeInTheDocument();
    expect(screen.getByText("Preview isn't available for this file type")).toBeInTheDocument();
  });

  it("renders no share/external-link icon — the whole card is already the open action", () => {
    const item = fileItem();
    render(
      <MediaBubble
        items={[item]}
        mine={false}
        urlFor={() => "https://example.test/media/att-1?t=sig"}
        isResolved
        onOpen={vi.fn()}
      />,
    );

    const card = screen.getByRole("button", { name: `Open ${item.name}` });
    expect(card.querySelector("svg.lucide-external-link")).not.toBeInTheDocument();
  });

  it("is not clickable while the signed link is still being minted", () => {
    const item = fileItem();
    render(
      <MediaBubble items={[item]} mine={false} urlFor={() => undefined} isResolved={false} onOpen={vi.fn()} />,
    );

    expect(screen.queryByRole("button", { name: `Open ${item.name}` })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: `Open ${item.name}` })).not.toBeInTheDocument();
    expect(screen.getByText(item.name)).toBeInTheDocument();
  });

  it("is not clickable once the link mint resolves without access", () => {
    const item = fileItem();
    render(
      <MediaBubble items={[item]} mine={false} urlFor={() => undefined} isResolved onOpen={vi.fn()} />,
    );

    expect(screen.queryByRole("button", { name: `Open ${item.name}` })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: `Open ${item.name}` })).not.toBeInTheDocument();
    expect(screen.getByText("Not available to you")).toBeInTheDocument();
  });

  it("is not clickable while its upload is still in progress", () => {
    const item = fileItem();
    render(
      <MediaBubble
        items={[item]}
        mine
        urlFor={() => "https://example.test/media/att-1?t=sig"}
        isResolved
        progress={{ [item.id]: { ratio: 0.4 } }}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: `Open ${item.name}` })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: `Open ${item.name}` })).not.toBeInTheDocument();
  });
});
