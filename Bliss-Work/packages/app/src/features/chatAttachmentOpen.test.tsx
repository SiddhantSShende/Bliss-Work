/**
 * Chat and channel file attachments, by host:
 *
 *   desktop → a file with no in-app view goes to the OS's own application through
 *             `config.openAttachment` (the same host call an email attachment uses)
 *   web     → a file with no in-app view points the BROWSER at the signed URL in a
 *             new tab, like the email card's link. The app fetches and saves nothing.
 *   any host→ images, video, PDF and plain text keep opening in the Lightbox
 *   others  → desktop's other windows and mobile have neither, so keep the Lightbox
 *
 * DMs use useChatMedia with scope "conversation", channels with "channel"; the
 * hook is the one place the click is routed, so it is run for both scopes with
 * the real MediaBubble and Lightbox. The conversation's "Docs" panel
 * (ChatAssetsSheet) lists the same files and is covered too. Only the runtime,
 * the toast, the file-transfer context, `fetch` and `window.open` are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AttachmentScope } from "@taskboard/shared";
import { encodeMedia, type MediaItem } from "../lib/chatEnvelope";

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
vi.mock("../lib/fileTransfer", () => ({
  useFileTransfers: () => ({ stateOf: () => undefined, decline: vi.fn(), cancel: vi.fn() }),
}));

import { useChatMedia } from "./useChatMedia";
import { ChatAssetsSheet } from "./ChatAssetsSheet";

const mk = (id: string, name: string, mime: string): MediaItem => ({ id, name, size: 2048, mime });
const PPTX = mk("att-pptx", "Quarterly.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
const DOCX = mk("att-docx", "Brief.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
const XLSX = mk("att-xlsx", "Budget.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
const ZIP = mk("att-zip", "Assets.zip", "application/zip");
const IMAGE = mk("att-img", "photo.png", "image/png");
const VIDEO = mk("att-vid", "clip.mp4", "video/mp4");
const PDF = mk("att-pdf", "Report.pdf", "application/pdf");
const TEXT = mk("att-txt", "notes.txt", "text/plain");

const urlOf = (id: string) => `https://msg.test/media/${id}?t=tok`;
const OPEN_ARGS = (id: string) => [urlOf(id), "_blank", "noopener,noreferrer"] as const;

const asWeb = () => {
  h.config = { kind: "web" };
};
const asDesktop = () => {
  h.config = { kind: "electron", openAttachment: vi.fn(async () => ({ ok: true })) };
  return h.config.openAttachment!;
};

let windowOpen: ReturnType<typeof vi.spyOn>;
let fetchStub: ReturnType<typeof vi.fn>;

/** One rendered message, through the same hook a DM or a channel uses. */
function Message({ scope, items }: { scope: AttachmentScope; items: MediaItem[] }) {
  const media = useChatMedia({ scope, scopeId: "scope-1", meId: "me", send: vi.fn() });
  return (
    <>
      {media.renderBody({ id: "m1", senderId: "peer", body: encodeMedia(items) })}
      {media.overlay}
    </>
  );
}

const withQuery = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {ui}
  </QueryClientProvider>
);

beforeEach(() => {
  h.toastError.mockReset();
  h.config = {};
  h.api.attachmentLinks.mockReset();
  h.api.attachmentLinks.mockImplementation(async (ids: string[]) =>
    ids.map((id) => ({ id, url: `/media/${id}?t=tok`, expiresAt: "2099-01-01T00:00:00Z" })),
  );
  windowOpen = vi.spyOn(window, "open").mockReturnValue(null);
  // The PDF/text Lightbox fetches its own bytes; this also proves the open path
  // itself never does.
  fetchStub = vi.fn(async () => new Response("", { status: 404 }));
  vi.stubGlobal("fetch", fetchStub);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each<[string, AttachmentScope]>([
  ["chat (DM conversation)", "conversation"],
  ["channel", "channel"],
])("%s attachment on WEB", (_label, scope) => {
  beforeEach(asWeb);

  it.each([PPTX, DOCX, XLSX, ZIP])(
    "opens $name in the browser, not the Lightbox, and downloads nothing itself",
    async (item) => {
      render(withQuery(<Message scope={scope} items={[item]} />));

      await userEvent.click(await screen.findByRole("button", { name: `Open ${item.name}` }));

      expect(windowOpen).toHaveBeenCalledExactlyOnceWith(...OPEN_ARGS(item.id));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(fetchStub).not.toHaveBeenCalled();
    },
  );

  it.each([IMAGE, VIDEO, PDF, TEXT])("keeps $name in the in-app viewer", async (item) => {
    render(withQuery(<Message scope={scope} items={[item]} />));

    await userEvent.click(await screen.findByRole("button", { name: `Open ${item.name}` }));

    expect(screen.getByRole("dialog", { name: item.name })).toBeInTheDocument();
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it("routes each file in a mixed message by its own type", async () => {
    render(withQuery(<Message scope={scope} items={[IMAGE, PPTX]} />));

    await userEvent.click(await screen.findByRole("button", { name: "Open Quarterly.pptx" }));

    expect(windowOpen).toHaveBeenCalledExactlyOnceWith(...OPEN_ARGS("att-pptx"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("no longer tells the user a file 'can't be previewed' when it opens in the browser", async () => {
    render(withQuery(<Message scope={scope} items={[PPTX]} />));

    await screen.findByRole("button", { name: "Open Quarterly.pptx" });

    expect(screen.queryByText(/Preview isn't available/)).not.toBeInTheDocument();
  });
});

describe("web attachment authorization stays enforced", () => {
  beforeEach(asWeb);

  it("opens exactly the signed URL the server minted for this viewer", async () => {
    render(withQuery(<Message scope="conversation" items={[PPTX]} />));

    await userEvent.click(await screen.findByRole("button", { name: "Open Quarterly.pptx" }));

    expect(h.api.attachmentLinks).toHaveBeenCalledWith(["att-pptx"]);
    expect(windowOpen.mock.calls[0]![0]).toBe("https://msg.test/media/att-pptx?t=tok");
  });

  it("offers nothing to click when the server would not mint a link (no access)", async () => {
    h.api.attachmentLinks.mockResolvedValue([]);
    render(withQuery(<Message scope="channel" items={[PPTX]} />));

    expect(await screen.findByText("Not available to you")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Quarterly.pptx" })).not.toBeInTheDocument();
    expect(windowOpen).not.toHaveBeenCalled();
  });
});

describe("desktop behaviour is unchanged", () => {
  it.each<[string, AttachmentScope]>([
    ["chat", "conversation"],
    ["channel", "channel"],
  ])("%s: an Office file still goes to the host's native open, not the browser", async (_l, scope) => {
    const openAttachment = asDesktop();
    render(withQuery(<Message scope={scope} items={[PPTX]} />));

    await userEvent.click(await screen.findByRole("button", { name: "Open Quarterly.pptx" }));

    expect(openAttachment).toHaveBeenCalledExactlyOnceWith(urlOf("att-pptx"), "Quarterly.pptx");
    expect(windowOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("reports a host failure the way an email attachment does", async () => {
    h.config = { kind: "electron", openAttachment: vi.fn(async () => ({ ok: false, error: "No application" })) };
    render(withQuery(<Message scope="conversation" items={[PPTX]} />));

    await userEvent.click(await screen.findByRole("button", { name: "Open Quarterly.pptx" }));

    expect(h.toastError).toHaveBeenCalledWith("Could not open Quarterly.pptx", { description: "No application" });
  });

  it("images and PDFs still open the Lightbox, never the host or the browser", async () => {
    const openAttachment = asDesktop();
    render(withQuery(<Message scope="conversation" items={[IMAGE, PDF]} />));

    await userEvent.click(await screen.findByRole("button", { name: "Open photo.png" }));

    expect(screen.getByRole("dialog", { name: "photo.png" })).toBeInTheDocument();
    expect(openAttachment).not.toHaveBeenCalled();
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it("another desktop window (no host open) is left alone: Lightbox, no browser tab", async () => {
    h.config = { kind: "electron" };
    render(withQuery(<Message scope="conversation" items={[PPTX]} />));

    await userEvent.click(await screen.findByRole("button", { name: "Open Quarterly.pptx" }));

    expect(screen.getByRole("dialog", { name: "Quarterly.pptx" })).toBeInTheDocument();
    expect(windowOpen).not.toHaveBeenCalled();
    expect(screen.getAllByText(/Preview (isn't|not) available/).length).toBeGreaterThan(0);
  });
});

describe("mobile behaviour is unchanged", () => {
  it("does not open a browser tab: Lightbox as before", async () => {
    h.config = { kind: "mobile" };
    render(withQuery(<Message scope="conversation" items={[PPTX]} />));

    await userEvent.click(await screen.findByRole("button", { name: "Open Quarterly.pptx" }));

    expect(screen.getByRole("dialog", { name: "Quarterly.pptx" })).toBeInTheDocument();
    expect(windowOpen).not.toHaveBeenCalled();
  });
});

describe("the conversation's Docs panel", () => {
  const messages = [
    { id: "m1", body: encodeMedia([PPTX, PDF]), senderName: "Sam", at: "2026-09-21T09:00:00Z" },
  ];
  const renderSheet = () =>
    render(withQuery(<ChatAssetsSheet open onClose={() => {}} title="Sam" messages={messages} />));
  const openDocsTab = async () => userEvent.click(await screen.findByRole("tab", { name: /Docs/ }));

  it("web: an Office doc opens in the browser", async () => {
    asWeb();
    renderSheet();
    await openDocsTab();

    await userEvent.click(await screen.findByRole("button", { name: "Open Quarterly.pptx" }));

    expect(windowOpen).toHaveBeenCalledExactlyOnceWith(...OPEN_ARGS("att-pptx"));
    expect(screen.queryByRole("dialog", { name: "Quarterly.pptx" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Preview isn't available/)).not.toBeInTheDocument();
  });

  it("web: a PDF doc still opens in the in-app viewer", async () => {
    asWeb();
    renderSheet();
    await openDocsTab();

    await userEvent.click(await screen.findByRole("button", { name: "Open Report.pdf" }));

    expect(screen.getByRole("dialog", { name: "Report.pdf" })).toBeInTheDocument();
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it("desktop: unchanged, the host opens it", async () => {
    const openAttachment = asDesktop();
    renderSheet();
    await openDocsTab();

    await userEvent.click(await screen.findByRole("button", { name: "Open Quarterly.pptx" }));

    expect(openAttachment).toHaveBeenCalledExactlyOnceWith(urlOf("att-pptx"), "Quarterly.pptx");
    expect(windowOpen).not.toHaveBeenCalled();
  });
});
