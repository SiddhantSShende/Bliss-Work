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
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AttachmentScope, ChannelMessageDTO } from "@taskboard/shared";
import { encodeMedia, type MediaItem } from "../lib/chatEnvelope";
import { qk } from "../lib/queryKeys";

type Host = { kind?: string; openAttachment?: ReturnType<typeof vi.fn> };
const h = vi.hoisted(() => ({
  api: {
    attachmentLinks: vi.fn(),
    mediaUrl: (path: string) => `https://msg.test${path}`,
    // Rest params so `mock.calls` is typed as the arguments the hook really passes.
    reply: vi.fn(async (..._args: unknown[]) => ({ messageId: "activity-msg", seq: 1, threadId: "thread-1" })),
    sendChannelMessage: vi.fn(async (..._args: unknown[]) => ({ messageId: "activity-msg", seq: 1 })),
    sendBeacon: vi.fn(async (..._args: unknown[]) => ({ sessionId: "s1", accepted: 1 })),
  },
  config: {} as Host,
  toastError: vi.fn(),
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: h.config }) }));
vi.mock("../store/session", () => ({
  useSession: (sel: (s: { user: { id: string; username: string; displayName: string } }) => unknown) =>
    sel({ user: { id: "me", username: "me", displayName: "Me" } }),
}));
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
function Message({ scope, items, locked }: { scope: AttachmentScope; items: MediaItem[]; locked?: boolean }) {
  const media = useChatMedia({ scope, scopeId: "scope-1", meId: "me", channelLocked: locked, send: vi.fn() });
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
  // mockReset + a fresh implementation, not mockClear: one test installs a
  // never-settling `reply`, which would otherwise leak into every later test.
  h.api.reply.mockReset();
  h.api.reply.mockImplementation(async () => ({ messageId: "activity-msg", seq: 1, threadId: "thread-1" }));
  h.api.sendChannelMessage.mockReset();
  h.api.sendChannelMessage.mockImplementation(async () => ({ messageId: "activity-msg", seq: 1 }));
  h.api.sendBeacon.mockReset();
  h.api.sendBeacon.mockImplementation(async () => ({ sessionId: "s1", accepted: 1 }));
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
    render(
      withQuery(
        <ChatAssetsSheet
          open
          onClose={() => {}}
          title="Sam"
          messages={messages}
          scope="conversation"
          scopeId="scope-1"
          meId="me"
        />,
      ),
    );
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

/** What telemetry was told, as [kind, attachmentId, filename] — recorded in EVERY context. */
const recorded = () =>
  h.api.sendBeacon.mock.calls.flatMap((c) =>
    (c[0] as { events: { action: string; targetId: string; detail: { filename: string } }[] }).events.map((e) => [
      e.action.replace(".", "_"),
      e.targetId,
      e.detail.filename,
    ]),
  );

/** The channel's own system message, if one was posted. A DM reply is never one. */
const channelPosts = () => h.api.sendChannelMessage.mock.calls.map((c) => [c[0], c[1], c[3], c[4], c[5]]);

describe("file activity — telemetry always, chat message only in a locked channel", () => {
  beforeEach(asWeb);

  it("LOCKED channel: posts the system message AND records telemetry when a file opens in the Lightbox", async () => {
    render(withQuery(<Message scope="channel" locked items={[PDF]} />));

    await userEvent.click(await screen.findByRole("button", { name: "Open Report.pdf" }));

    expect(h.api.sendChannelMessage).toHaveBeenCalledExactlyOnceWith(
      "scope-1",
      "Me opened Report.pdf",
      expect.any(String),
      "attachment_opened",
      undefined,
      "att-pdf",
    );
    expect(recorded()).toEqual([["attachment_opened", "att-pdf", "Report.pdf"]]);
    expect(h.api.reply).not.toHaveBeenCalled();
  });

  it("LOCKED channel: posts attachment_opened — never downloaded — when a file opens in a browser tab", async () => {
    render(withQuery(<Message scope="channel" locked items={[PPTX]} />));

    await userEvent.click(await screen.findByRole("button", { name: "Open Quarterly.pptx" }));

    expect(windowOpen).toHaveBeenCalledExactlyOnceWith(...OPEN_ARGS("att-pptx"));
    expect(channelPosts()).toEqual([["scope-1", "Me opened Quarterly.pptx", "attachment_opened", undefined, "att-pptx"]]);
    expect(recorded()).toEqual([["attachment_opened", "att-pptx", "Quarterly.pptx"]]);
  });

  it("LOCKED channel: the Docs panel posts and records its own open too", async () => {
    render(
      withQuery(
        <ChatAssetsSheet
          open
          onClose={() => {}}
          title="Sam"
          messages={[{ id: "m1", body: encodeMedia([PDF]), senderName: "Sam", at: "2026-09-21T09:00:00Z" }]}
          scope="channel"
          scopeId="channel-9"
          meId="me"
          channelLocked
        />,
      ),
    );
    await userEvent.click(await screen.findByRole("tab", { name: /Docs/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Open Report.pdf" }));

    expect(channelPosts()).toEqual([["channel-9", "Me opened Report.pdf", "attachment_opened", undefined, "att-pdf"]]);
    expect(recorded()).toEqual([["attachment_opened", "att-pdf", "Report.pdf"]]);
  });

  it.each([
    ["OPEN channel", { scope: "channel", locked: false }],
    ["channel whose lock state is not known yet", { scope: "channel", locked: undefined }],
  ] as const)("%s: records telemetry and posts NOTHING to the chat", async (_label, ctx) => {
    render(withQuery(<Message scope={ctx.scope} locked={ctx.locked} items={[PDF]} />));

    await userEvent.click(await screen.findByRole("button", { name: "Open Report.pdf" }));

    expect(recorded()).toEqual([["attachment_opened", "att-pdf", "Report.pdf"]]);
    expect(h.api.sendChannelMessage).not.toHaveBeenCalled();
    expect(h.api.reply).not.toHaveBeenCalled();
  });

  it("DM / group chat: records telemetry and posts NOTHING to the chat — no reply, no thread", async () => {
    render(withQuery(<Message scope="conversation" items={[PDF]} />));

    await userEvent.click(await screen.findByRole("button", { name: "Open Report.pdf" }));

    expect(recorded()).toEqual([["attachment_opened", "att-pdf", "Report.pdf"]]);
    expect(h.api.reply).not.toHaveBeenCalled();
    expect(h.api.sendChannelMessage).not.toHaveBeenCalled();
  });

  it("DM / group chat: a lock flag is meaningless there and never makes a message appear", async () => {
    render(withQuery(<Message scope="conversation" locked items={[PDF]} />));

    await userEvent.click(await screen.findByRole("button", { name: "Open Report.pdf" }));

    expect(h.api.reply).not.toHaveBeenCalled();
    expect(h.api.sendChannelMessage).not.toHaveBeenCalled();
    expect(recorded()).toHaveLength(1);
  });

  it("tells telemetry the host, the surface and the scope — and nothing it should not", async () => {
    render(withQuery(<Message scope="channel" items={[PDF]} />));

    await userEvent.click(await screen.findByRole("button", { name: "Open Report.pdf" }));

    expect(h.api.sendBeacon).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        source: "web",
        ended: false,
        events: [
          expect.objectContaining({
            action: "attachment.opened",
            category: "engagement",
            surface: "channels",
            targetKind: "attachment",
            targetId: "att-pdf",
            detail: { filename: "Report.pdf", channel: "scope-1" },
          }),
        ],
      }),
    );
  });

  it("reports source desktop from the desktop host", async () => {
    asDesktop();
    render(withQuery(<Message scope="conversation" items={[PPTX]} />));

    await userEvent.click(await screen.findByRole("button", { name: "Open Quarterly.pptx" }));

    expect(h.api.sendBeacon.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ source: "desktop" }));
  });

  it.each([PPTX, DOCX, XLSX, ZIP])(
    "records exactly one attachment_opened for a click on $name, however the browser then handles it",
    async (item) => {
      render(withQuery(<Message scope="conversation" items={[item]} />));

      await userEvent.click(await screen.findByRole("button", { name: `Open ${item.name}` }));

      expect(recorded().map((r) => r[0])).toEqual(["attachment_opened"]);
    },
  );

  it("records attachment_opened when desktop hands a file to the OS's own application", async () => {
    const openAttachment = asDesktop();
    render(withQuery(<Message scope="conversation" items={[PPTX]} />));

    await userEvent.click(await screen.findByRole("button", { name: "Open Quarterly.pptx" }));

    expect(openAttachment).toHaveBeenCalledExactlyOnceWith(urlOf("att-pptx"), "Quarterly.pptx");
    expect(recorded().map((r) => r[0])).toEqual(["attachment_opened"]);
  });

  it("the Docs panel in a DM records its open for a file that leaves the app, with no chat message", async () => {
    render(
      withQuery(
        <ChatAssetsSheet
          open
          onClose={() => {}}
          title="Sam"
          messages={[{ id: "m1", body: encodeMedia([PPTX]), senderName: "Sam", at: "2026-09-21T09:00:00Z" }]}
          scope="conversation"
          scopeId="scope-3"
          meId="me"
        />,
      ),
    );
    await userEvent.click(await screen.findByRole("tab", { name: /Docs/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Open Quarterly.pptx" }));

    expect(windowOpen).toHaveBeenCalledExactlyOnceWith(...OPEN_ARGS("att-pptx"));
    expect(recorded().map((r) => r[0])).toEqual(["attachment_opened"]);
    expect(h.api.reply).not.toHaveBeenCalled();
  });

  // A normal click is never a download: no `download` attribute anywhere, no
  // scripted anchor, and the URL carries no explicit-download flag. What
  // makes something a download is the server's `?dl=1`, and only 3-dot →
  // Download sends it (chatAttachmentDownload.test.tsx).
  it("a normal click never creates a download anchor and never sends ?dl=1", async () => {
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const { container } = render(withQuery(<Message scope="conversation" items={[PPTX, IMAGE, PDF]} />));

    for (const name of ["Open Quarterly.pptx", "Open photo.png", "Open Report.pdf"]) {
      await userEvent.click(await screen.findByRole("button", { name }));
    }

    expect(anchorClick).not.toHaveBeenCalled();
    expect(container.querySelector("a[download]")).toBeNull();
    expect(document.querySelector("a[download]")).toBeNull();
    for (const [url] of windowOpen.mock.calls) expect(String(url)).not.toContain("dl=1");
  });

  it("never claims an activity event for a file that never rendered — no click, nothing recorded or posted", async () => {
    render(withQuery(<Message scope="channel" locked items={[PDF]} />));

    await screen.findByRole("button", { name: "Open Report.pdf" });

    expect(h.api.sendBeacon).not.toHaveBeenCalled();
    expect(h.api.reply).not.toHaveBeenCalled();
    expect(h.api.sendChannelMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["locked channel", "channel", true],
    ["open channel", "channel", false],
    ["DM", "conversation", undefined],
  ] as const)("%s: a double click before the first request settles records and posts once", async (_l, scope, locked) => {
    h.api.sendBeacon.mockImplementation(() => new Promise(() => {})); // never settles within the test
    h.api.sendChannelMessage.mockImplementation(() => new Promise(() => {}));
    render(withQuery(<Message scope={scope} locked={locked} items={[PDF]} />));
    const button = await screen.findByRole("button", { name: "Open Report.pdf" });

    await userEvent.click(button);
    await userEvent.click(button);

    expect(h.api.sendBeacon).toHaveBeenCalledTimes(1);
    expect(h.api.sendChannelMessage).toHaveBeenCalledTimes(locked ? 1 : 0);
  });

  it("a failing telemetry call never breaks the open", async () => {
    h.api.sendBeacon.mockImplementation(async () => {
      throw new Error("telemetry down");
    });
    render(withQuery(<Message scope="channel" locked items={[PDF]} />));

    await userEvent.click(await screen.findByRole("button", { name: "Open Report.pdf" }));

    expect(screen.getByRole("dialog", { name: "Report.pdf" })).toBeInTheDocument();
    expect(h.api.sendChannelMessage).toHaveBeenCalledTimes(1);
  });

  it("the Media tab's own thumbnail also records attachment_opened — never downloaded, since images/video always render inline", async () => {
    render(
      withQuery(
        <ChatAssetsSheet
          open
          onClose={() => {}}
          title="Sam"
          messages={[{ id: "m1", body: encodeMedia([IMAGE]), senderName: "Sam", at: "2026-09-21T09:00:00Z" }]}
          scope="conversation"
          scopeId="scope-7"
          meId="me"
        />,
      ),
    );
    // Media is the default tab — no tab click needed first.
    await userEvent.click(await screen.findByRole("link", { name: "Open photo.png" }));

    expect(recorded()).toEqual([["attachment_opened", "att-img", "photo.png"]]);
    expect(h.api.reply).not.toHaveBeenCalled();
    expect(h.api.sendChannelMessage).not.toHaveBeenCalled();
  });

  it("an unresolved Media tile (no access) records nothing — there is no URL to actually open", async () => {
    h.api.attachmentLinks.mockResolvedValue([]);
    render(
      withQuery(
        <ChatAssetsSheet
          open
          onClose={() => {}}
          title="Sam"
          messages={[{ id: "m1", body: encodeMedia([IMAGE]), senderName: "Sam", at: "2026-09-21T09:00:00Z" }]}
          scope="conversation"
          scopeId="scope-7"
          meId="me"
        />,
      ),
    );
    // An unresolved tile's href is omitted (no URL to point at), so it no
    // longer carries the implicit "link" role — found by its title instead.
    const tile = await screen.findByTitle(/photo\.png/);
    await userEvent.click(tile);

    expect(h.api.sendBeacon).not.toHaveBeenCalled();
    expect(h.api.reply).not.toHaveBeenCalled();
  });

  // The realtime bridge (queryBridge.tsx) never echoes the sender's own
  // ChannelMessageCreated event back into this same query — that skip is what
  // makes this cache patch the ONLY place the sender's own pill gets rendered.
  // This test guards the other half: if that invariant were ever violated (a
  // WS echo racing the HTTP response into the SAME cache entry), the
  // messageId dedup below must still prevent a visible duplicate.
  it("LOCKED channel: never double-renders the sender's own pill even if the message id is already in cache", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData<ChannelMessageDTO[]>(qk.channelMessages("scope-1"), [
      {
        id: "activity-msg",
        channelId: "scope-1",
        seq: 1,
        senderId: "me",
        senderUsername: "me",
        body: "Me opened Report.pdf",
        kind: "attachment_opened",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]);
    render(
      <QueryClientProvider client={qc}>
        <Message scope="channel" locked items={[PDF]} />
      </QueryClientProvider>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Open Report.pdf" }));
    await waitFor(() => expect(h.api.sendChannelMessage).toHaveBeenCalledTimes(1));

    const list = qc.getQueryData<ChannelMessageDTO[]>(qk.channelMessages("scope-1")) ?? [];
    expect(list.filter((m) => m.id === "activity-msg")).toHaveLength(1);
  });
});
