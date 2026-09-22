/**
 * A received email's attachments, by host:
 *
 *   web     → a file with no in-app view is a new-tab link straight to the signed
 *             URL (the browser-open path). Nothing is fetched or saved by the app.
 *   desktop → the same file goes to the OS's own application through
 *             `config.openAttachment`, exactly as before.
 *   any host→ images, video, PDF and plain text keep opening in the in-app viewer.
 *
 * Chat and channel attachments take the same decisions through
 * lib/openAttachment (see chatAttachmentOpen.test.tsx), so all three surfaces
 * agree on which types have an in-app view. Runs the real MailAttachmentCards;
 * only the runtime, the signed-link mint, `fetch`, `window.open` and the toast
 * are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MailAttachmentDTO } from "@taskboard/shared";

type Host = { kind?: string; openAttachment?: ReturnType<typeof vi.fn> };
const h = vi.hoisted(() => ({
  api: {
    attachmentLinks: vi.fn(),
    mediaUrl: (path: string) => `https://msg.test${path}`,
  },
  config: {} as Host,
  toastError: vi.fn(),
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: h.config }) }));
vi.mock("sonner", () => ({ toast: { error: h.toastError, success: vi.fn() } }));

import { MailAttachmentCards } from "./MailAttachments";

const mk = (id: string, filename: string, mime: string): MailAttachmentDTO => ({
  id,
  filename,
  mime,
  sizeBytes: 2048,
});
const PPTX = mk("att-pptx", "Quarterly.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
const DOCX = mk("att-docx", "Brief.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
const XLSX = mk("att-xlsx", "Budget.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
const ZIP = mk("att-zip", "Assets.zip", "application/zip");
const IMAGE = mk("att-img", "photo.png", "image/png");
const VIDEO = mk("att-vid", "clip.mp4", "video/mp4");
const PDF = mk("att-pdf", "Report.pdf", "application/pdf");
const TEXT = mk("att-txt", "notes.txt", "text/plain");

const urlOf = (id: string) => `https://msg.test/media/${id}?t=tok`;

let windowOpen: ReturnType<typeof vi.spyOn>;
let fetchStub: ReturnType<typeof vi.fn>;

function renderCards(attachments: MailAttachmentDTO[]) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MailAttachmentCards attachments={attachments} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.toastError.mockReset();
  h.config = { kind: "web" };
  h.api.attachmentLinks.mockReset();
  h.api.attachmentLinks.mockImplementation(async (ids: string[]) =>
    ids.map((id) => ({ id, url: `/media/${id}?t=tok`, expiresAt: "2099-01-01T00:00:00Z" })),
  );
  windowOpen = vi.spyOn(window, "open").mockReturnValue(null);
  // The PDF/text Lightbox fetches its own bytes; this also proves the card
  // itself never fetches (i.e. never downloads first).
  fetchStub = vi.fn(async () => new Response("", { status: 404 }));
  vi.stubGlobal("fetch", fetchStub);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("email attachment on WEB", () => {
  it.each([PPTX, DOCX, XLSX, ZIP])(
    "$filename is a new-tab link to the authorized URL, not the viewer, and nothing is downloaded first",
    async (a) => {
      renderCards([a]);

      const link = await screen.findByRole("link", { name: `Open ${a.filename}` });

      expect(link).toHaveAttribute("href", urlOf(a.id));
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
      expect(screen.queryByRole("button", { name: /Preview/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(fetchStub).not.toHaveBeenCalled();
      expect(windowOpen).not.toHaveBeenCalled();
    },
  );

  it.each([IMAGE, VIDEO, PDF, TEXT])("keeps $filename in the in-app viewer", async (a) => {
    renderCards([a]);

    await userEvent.click(await screen.findByRole("button", { name: `Preview ${a.filename}` }));

    expect(screen.getByRole("dialog", { name: a.filename })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: `Open ${a.filename}` })).not.toBeInTheDocument();
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it("routes each attachment in one mail by its own type", async () => {
    renderCards([PDF, PPTX]);

    expect(await screen.findByRole("button", { name: "Preview Report.pdf" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Open Quarterly.pptx" })).toHaveAttribute("href", urlOf("att-pptx"));
  });
});

describe("email attachment authorization stays enforced", () => {
  it("links only to the signed URL the server minted for this viewer", async () => {
    renderCards([PPTX]);

    const link = await screen.findByRole("link", { name: "Open Quarterly.pptx" });

    expect(h.api.attachmentLinks).toHaveBeenCalledWith(["att-pptx"]);
    expect(link).toHaveAttribute("href", "https://msg.test/media/att-pptx?t=tok");
  });

  it("offers no link when the server would not mint one (no access)", async () => {
    h.api.attachmentLinks.mockResolvedValue([]);
    renderCards([PPTX]);

    expect(await screen.findByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open Quarterly.pptx" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Quarterly.pptx" })).not.toBeInTheDocument();
  });
});

describe("email attachment on DESKTOP (unchanged)", () => {
  it("Open on an Office file calls the host with the signed URL and file name, not a link", async () => {
    h.config = { kind: "electron", openAttachment: vi.fn(async () => ({ ok: true })) };
    renderCards([PPTX]);

    await userEvent.click(await screen.findByRole("button", { name: "Open Quarterly.pptx" }));

    expect(h.config.openAttachment).toHaveBeenCalledExactlyOnceWith(urlOf("att-pptx"), "Quarterly.pptx");
    expect(screen.queryByRole("link", { name: "Open Quarterly.pptx" })).not.toBeInTheDocument();
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it("a host failure is reported to the user", async () => {
    h.config = { kind: "electron", openAttachment: vi.fn(async () => ({ ok: false, error: "No application" })) };
    renderCards([PPTX]);

    await userEvent.click(await screen.findByRole("button", { name: "Open Quarterly.pptx" }));

    expect(h.toastError).toHaveBeenCalledWith("Could not open Quarterly.pptx", { description: "No application" });
  });

  it("a PDF still previews in-app instead of opening natively", async () => {
    h.config = { kind: "electron", openAttachment: vi.fn(async () => ({ ok: true })) };
    renderCards([PDF]);

    await userEvent.click(await screen.findByRole("button", { name: "Preview Report.pdf" }));

    expect(h.config.openAttachment).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Report.pdf" })).toBeInTheDocument();
  });

  it("another desktop window (no host open) keeps its link, as before", async () => {
    h.config = { kind: "electron" };
    renderCards([PPTX]);

    expect(await screen.findByRole("link", { name: "Open Quarterly.pptx" })).toHaveAttribute("href", urlOf("att-pptx"));
  });
});
