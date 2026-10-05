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
    recordMailAttachmentDownload: vi.fn(),
  },
  config: {} as Host,
  toastError: vi.fn(),
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: h.config }) }));
vi.mock("sonner", () => ({ toast: { error: h.toastError, success: vi.fn() } }));

import { MailAttachmentCards } from "./MailAttachments";
import { DOWNLOAD_COOLDOWN_MS } from "../lib/useMailAttachmentDownload";

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
/** Every scripted `<a>.click()` — jsdom cannot navigate, so this is the download. */
let saved: { href: string; download: string | null }[];

function renderCards(attachments: MailAttachmentDTO[]) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MailAttachmentCards mailId="mail-1" attachments={attachments} />
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
  h.api.recordMailAttachmentDownload.mockReset();
  h.api.recordMailAttachmentDownload.mockResolvedValue(undefined);
  saved = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ href: this.href, download: this.getAttribute("download") });
  });
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

// ── The explicit Download ────────────────────────────────────────────────────
//
// A different act from Preview/Open: it SAVES the file (the shared
// downloadAttachment, i.e. the signed URL + `?dl=1`) and records "download
// initiated" in the admin activity timeline. Preview and Open record nothing.

const ALL_TYPES = [PPTX, DOCX, XLSX, ZIP, IMAGE, VIDEO, PDF, TEXT];
const downloadButton = (a: MailAttachmentDTO) => screen.findByRole("button", { name: `Download ${a.filename}` });
const dlUrl = (id: string) => `${urlOf(id)}&dl=1`;

describe("email attachment Download", () => {
  it.each(ALL_TYPES)("$filename has a Download action, alongside its Preview or Open", async (a) => {
    renderCards([a]);

    expect(await downloadButton(a)).toBeInTheDocument();
    // Download is additive: the card still has exactly its one view/open action.
    const viewOrOpen = [
      ...screen.queryAllByRole("button", { name: new RegExp(`^(Preview|Open) ${a.filename}$`) }),
      ...screen.queryAllByRole("link", { name: new RegExp(`^(Preview|Open) ${a.filename}$`) }),
    ];
    expect(viewOrOpen).toHaveLength(1);
  });

  it.each([IMAGE, PPTX])("pressing Download on $filename saves it through ?dl=1 under its own name", async (a) => {
    renderCards([a]);

    await userEvent.click(await downloadButton(a));

    expect(saved).toEqual([{ href: dlUrl(a.id), download: a.filename }]);
    // Saved, not opened: no tab, no viewer, no native open, and no fetch/buffer.
    expect(windowOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("records the download against this mail and file — once", async () => {
    renderCards([IMAGE]);

    await userEvent.click(await downloadButton(IMAGE));

    expect(h.api.recordMailAttachmentDownload).toHaveBeenCalledExactlyOnceWith("mail-1", "att-img");
  });

  it("works the same on the desktop host, without touching the native Open", async () => {
    const openAttachment = vi.fn(async () => ({ ok: true }));
    h.config = { kind: "electron", openAttachment };
    renderCards([PPTX]);

    await userEvent.click(await downloadButton(PPTX));

    expect(saved).toEqual([{ href: dlUrl("att-pptx"), download: "Quarterly.pptx" }]);
    expect(openAttachment).not.toHaveBeenCalled();
    expect(h.api.recordMailAttachmentDownload).toHaveBeenCalledExactlyOnceWith("mail-1", "att-pptx");
  });

  it("is not offered when the server minted no link for this viewer", async () => {
    h.api.attachmentLinks.mockResolvedValue([]);
    renderCards([IMAGE]);

    expect(await screen.findByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Download / })).not.toBeInTheDocument();
  });

  it("still saves the file when recording it fails (the download is not blocked)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    h.api.recordMailAttachmentDownload.mockRejectedValue(new Error("network down"));
    renderCards([PDF]);

    await userEvent.click(await downloadButton(PDF));

    expect(saved).toEqual([{ href: dlUrl("att-pdf"), download: "Report.pdf" }]);
    await vi.waitFor(() => expect(err).toHaveBeenCalled());
    expect(h.toastError).not.toHaveBeenCalled();
  });
});

describe("Preview and Open are NOT downloads", () => {
  it("Preview opens the viewer and records nothing", async () => {
    renderCards([IMAGE]);

    await userEvent.click(await screen.findByRole("button", { name: "Preview photo.png" }));

    expect(screen.getByRole("dialog", { name: "photo.png" })).toBeInTheDocument();
    expect(saved).toEqual([]);
    expect(h.api.recordMailAttachmentDownload).not.toHaveBeenCalled();
  });

  it("the web Open link keeps its plain signed URL (no ?dl=1) and records nothing", async () => {
    renderCards([PPTX]);

    const link = await screen.findByRole("link", { name: "Open Quarterly.pptx" });
    await userEvent.click(link);

    expect(link).toHaveAttribute("href", urlOf("att-pptx"));
    expect(link.getAttribute("href")).not.toContain("dl=1");
    expect(h.api.recordMailAttachmentDownload).not.toHaveBeenCalled();
  });

  it("the desktop native Open calls the host and records nothing", async () => {
    h.config = { kind: "electron", openAttachment: vi.fn(async () => ({ ok: true })) };
    renderCards([PPTX]);

    await userEvent.click(await screen.findByRole("button", { name: "Open Quarterly.pptx" }));

    expect(h.config.openAttachment).toHaveBeenCalledOnce();
    expect(saved).toEqual([]);
    expect(h.api.recordMailAttachmentDownload).not.toHaveBeenCalled();
  });
});

describe("Download duplicate guard", () => {
  // The hook's window is on Date.now(), so a controllable clock exercises it
  // without fake timers fighting userEvent and react-query.
  let clock: number;
  beforeEach(() => {
    clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
  });

  it("a rapid double-click saves and records once", async () => {
    renderCards([IMAGE]);
    const btn = await downloadButton(IMAGE);

    await userEvent.dblClick(btn);

    expect(saved).toHaveLength(1);
    expect(h.api.recordMailAttachmentDownload).toHaveBeenCalledTimes(1);
  });

  it("a press shortly after (still inside the window) is the same intent", async () => {
    renderCards([IMAGE]);
    const btn = await downloadButton(IMAGE);

    await userEvent.click(btn);
    clock += DOWNLOAD_COOLDOWN_MS - 1;
    await userEvent.click(btn);

    expect(saved).toHaveLength(1);
    expect(h.api.recordMailAttachmentDownload).toHaveBeenCalledTimes(1);
  });

  it("a later, deliberate download of the same file is saved and recorded again", async () => {
    renderCards([IMAGE]);
    const btn = await downloadButton(IMAGE);

    await userEvent.click(btn);
    clock += DOWNLOAD_COOLDOWN_MS;
    await userEvent.click(btn);

    expect(saved).toHaveLength(2);
    expect(h.api.recordMailAttachmentDownload).toHaveBeenCalledTimes(2);
    expect(h.api.recordMailAttachmentDownload).toHaveBeenNthCalledWith(2, "mail-1", "att-img");
  });

  it("the guard is per file: downloading two different files back to back records both", async () => {
    renderCards([IMAGE, PDF]);

    await userEvent.click(await downloadButton(IMAGE));
    await userEvent.click(await downloadButton(PDF));

    expect(saved.map((x) => x.download)).toEqual(["photo.png", "Report.pdf"]);
    expect(h.api.recordMailAttachmentDownload.mock.calls).toEqual([
      ["mail-1", "att-img"],
      ["mail-1", "att-pdf"],
    ]);
  });
});
