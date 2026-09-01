/**
 * MailAttachmentCards — the received-mail attachment list.
 *
 * Regression coverage for the bug this fix addresses: every attachment used a
 * same-tab `<a download>` link. On Electron, `will-navigate` (harden.ts)
 * fires for exactly that click and cancels it outright — a signed attachment
 * URL is never "our own content" — so the button did nothing at all. The fix
 * splits by mime: a previewable type (image/video/PDF/text) opens the shared
 * in-app Lightbox; everything else opens via `target="_blank"` (no `download`
 * attribute), which goes through Electron's `setWindowOpenHandler` instead —
 * the path that actually works.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MailAttachmentCards } from "./MailAttachments";
import { useAttachmentLinks as useAttachmentLinksMock } from "../lib/useAttachmentLinks";
import { useRuntime as useRuntimeMock } from "../lib/runtime";
import type { MailAttachmentDTO } from "@taskboard/shared";

// MailAttachmentCards now reads config.openAttachment (desktop-only) via
// useRuntime() — see ChatsList.test.tsx for the same base pattern. Defaults to
// the plain web `config` (no openAttachment) so every existing assertion
// below about the `target="_blank"` link stays exactly as it was before this
// mock was needed; individual tests override it with mockReturnValueOnce to
// exercise the desktop native-open path.
vi.mock("../lib/runtime", () => ({ useRuntime: vi.fn(() => ({ config: { kind: "web" } })) }));

vi.mock("../lib/useAttachmentLinks", () => ({
  useAttachmentLinks: vi.fn((ids: string[]) => ({
    urlFor: (id: string | undefined) =>
      id && ids.includes(id) ? `https://example.test/media/${id}?t=sig` : undefined,
    isLoading: false,
    isResolved: true,
  })),
}));

function attachment(over: Partial<MailAttachmentDTO> & { id: string }): MailAttachmentDTO {
  return { filename: "file", mime: "application/octet-stream", sizeBytes: 1024, ...over };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MailAttachmentCards", () => {
  it("opens a PDF in the in-app Lightbox instead of a same-tab download link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("%PDF-1.4", { status: 200, headers: { "content-type": "application/pdf" } }),
      ),
    );
    const pdf = attachment({ id: "a1", filename: "invoice.pdf", mime: "application/pdf" });
    render(<MailAttachmentCards attachments={[pdf]} />);

    expect(screen.queryByRole("link", { name: `Open ${pdf.filename}` })).not.toBeInTheDocument();
    const previewBtn = screen.getByRole("button", { name: `Preview ${pdf.filename}` });
    await userEvent.click(previewBtn);

    expect(await screen.findByRole("dialog", { name: pdf.filename })).toBeInTheDocument();
  });

  it("opens a non-previewable file via target=_blank, never a same-tab download link", () => {
    const doc = attachment({ id: "a2", filename: "report.docx", mime: "application/vnd.ms-word" });
    render(<MailAttachmentCards attachments={[doc]} />);

    const link = screen.getByRole("link", { name: `Open ${doc.filename}` });
    expect(link).toHaveAttribute("href", "https://example.test/media/a2?t=sig");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    // The regression itself: a `download` attribute makes this a same-tab
    // navigation, which Electron's will-navigate guard cancels outright.
    expect(link).not.toHaveAttribute("download");
  });

  it("shows the received image as a preview button, not a raw download link", () => {
    const photo = attachment({ id: "a3", filename: "photo.png", mime: "image/png" });
    render(<MailAttachmentCards attachments={[photo]} />);

    expect(screen.getByRole("button", { name: `Preview ${photo.filename}` })).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders nothing clickable while the signed link is still being minted", () => {
    vi.mocked(useAttachmentLinksMock).mockReturnValueOnce({
      urlFor: () => undefined,
      isLoading: true,
      isResolved: false,
    });
    const file = attachment({ id: "a4", filename: "unresolved.pdf", mime: "application/pdf" });
    render(<MailAttachmentCards attachments={[file]} />);

    expect(screen.queryByRole("button", { name: `Preview ${file.filename}` })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: `Open ${file.filename}` })).not.toBeInTheDocument();
    expect(screen.getByText("Preparing…")).toBeInTheDocument();
  });

  it("shows 'Unavailable' once the mint resolves without access, not a dead link", () => {
    vi.mocked(useAttachmentLinksMock).mockReturnValueOnce({
      urlFor: () => undefined,
      isLoading: false,
      isResolved: true,
    });
    const file = attachment({ id: "a5", filename: "denied.pdf", mime: "application/pdf" });
    render(<MailAttachmentCards attachments={[file]} />);

    expect(screen.queryByRole("button", { name: `Preview ${file.filename}` })).not.toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
  });

  // Desktop-only: when config.openAttachment exists, a non-previewable file
  // opens via that IPC call instead of a target="_blank" anchor — no browser
  // tab, no `<a href>` at all.
  it("on desktop, opens a non-previewable file via config.openAttachment, not target=_blank", async () => {
    const openAttachment = vi.fn().mockResolvedValue({ ok: true });
    vi.mocked(useRuntimeMock).mockReturnValueOnce({ config: { kind: "desktop", openAttachment } } as never);
    const doc = attachment({ id: "a6", filename: "report.docx", mime: "application/vnd.ms-word" });
    render(<MailAttachmentCards attachments={[doc]} />);

    expect(screen.queryByRole("link", { name: `Open ${doc.filename}` })).not.toBeInTheDocument();
    const openBtn = screen.getByRole("button", { name: `Open ${doc.filename}` });
    await userEvent.click(openBtn);

    expect(openAttachment).toHaveBeenCalledWith("https://example.test/media/a6?t=sig", doc.filename);
  });

  // This app does not download files of any kind — the non-previewable
  // fallback used to say "Download" (with a Download icon) despite already
  // only opening a new tab. Pins the wording/iconography, not just the
  // behavior the other tests already cover.
  it("never shows the word 'Download' anywhere, on web or desktop", () => {
    const doc = attachment({ id: "a7", filename: "report.docx", mime: "application/vnd.ms-word" });
    const { unmount } = render(<MailAttachmentCards attachments={[doc]} />);
    expect(screen.queryByText(/download/i)).not.toBeInTheDocument();
    unmount();

    vi.mocked(useRuntimeMock).mockReturnValueOnce({
      config: { kind: "desktop", openAttachment: vi.fn() },
    } as never);
    render(<MailAttachmentCards attachments={[doc]} />);
    expect(screen.queryByText(/download/i)).not.toBeInTheDocument();
  });
});
