/**
 * The explicit download: a file's 3-dot menu → Download. The only deliberate
 * download path; a normal click on the file OPENS it (chatAttachmentOpen.test.tsx).
 *
 *   • Download saves through the viewer's own signed URL with `?dl=1` — the flag
 *     the server turns into `Content-Disposition: attachment` — on a scripted
 *     `<a download>`. Nothing is opened in a tab or the Lightbox.
 *   • It records exactly one `attachment_downloaded`, never an `attachment_opened`
 *     alongside it, in the same DM or channel the file lives in.
 *
 * Runs the REAL ChatThread + MessageActions + useChatMedia together, in both scopes
 * (DMs use "conversation", channels "channel"); only the runtime, the session, the
 * toast, the file-transfer context, `fetch`, `window.open` and the anchor's
 * `click()` (jsdom cannot navigate) are stubbed.
 */
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AttachmentScope } from "@taskboard/shared";
import { encodeMedia, type MediaItem } from "../lib/chatEnvelope";

const h = vi.hoisted(() => ({
  api: {
    attachmentLinks: vi.fn(),
    mediaUrl: (path: string) => `https://msg.test${path}`,
    // Rest params so `mock.calls` is typed as the arguments the hook really passes.
    reply: vi.fn(async (..._args: unknown[]) => ({ messageId: "activity-msg", seq: 1, threadId: "thread-1" })),
    sendChannelMessage: vi.fn(async (..._args: unknown[]) => ({ messageId: "activity-msg", seq: 1 })),
    graphql: vi.fn(async () => ({ users: [] })),
  },
  config: { kind: "web" } as { kind?: string },
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: h.config }) }));
vi.mock("../store/session", () => ({
  useSession: (sel: (s: { user: { id: string; username: string; displayName: string } }) => unknown) =>
    sel({ user: { id: "me", username: "me", displayName: "Me" } }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("../lib/fileTransfer", () => ({
  useFileTransfers: () => ({ stateOf: () => undefined, decline: vi.fn(), cancel: vi.fn() }),
}));

import { useChatMedia } from "./useChatMedia";
import { ChatThread, type ThreadMessage } from "./ChatThread";

const mk = (id: string, name: string, mime: string): MediaItem => ({ id, name, size: 2048, mime });
const PPTX = mk("att-pptx", "Quarterly.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
const DOCX = mk("att-docx", "Brief.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
const XLSX = mk("att-xlsx", "Budget.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
const ZIP = mk("att-zip", "Assets.zip", "application/zip");
const IMAGE = mk("att-img", "photo.png", "image/png");
const PDF = mk("att-pdf", "Report.pdf", "application/pdf");
const TEXT = mk("att-txt", "notes.txt", "text/plain");

const urlOf = (id: string) => `https://msg.test/media/${id}?t=tok`;

type Saved = { href: string; download: string | null };
let saved: Saved[];
let windowOpen: ReturnType<typeof vi.spyOn>;

/** One thread of messages, wired exactly the way DMView/ChannelView wire it. */
function Thread({ scope, messages }: { scope: AttachmentScope; messages: ThreadMessage[] }) {
  const media = useChatMedia({ scope, scopeId: "scope-1", meId: "me", send: vi.fn() });
  return (
    <ChatThread
      threadId="t1"
      messages={messages}
      meId="me"
      onSend={vi.fn()}
      renderBody={media.renderBody}
      onDownloadFile={media.downloadItem}
      overlay={media.overlay}
    />
  );
}

const fileMessage = (items: MediaItem[], id = "m1"): ThreadMessage => ({
  id,
  senderId: "peer",
  body: encodeMedia(items),
  at: "2026-09-21T09:00:00Z",
});

const renderThread = (scope: AttachmentScope, messages: ThreadMessage[]) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Thread scope={scope} messages={messages} />
    </QueryClientProvider>,
  );

/** The activity posted, whichever endpoint this scope uses: [kind, attachmentId, body]. */
const posted = (scope: AttachmentScope) =>
  scope === "conversation"
    ? h.api.reply.mock.calls.map((c) => [c[4], c[5], c[1]])
    : h.api.sendChannelMessage.mock.calls.map((c) => [c[3], c[5], c[1]]);

const openMenu = async () => {
  await userEvent.click(await screen.findByRole("button", { name: "Message actions" }));
};

beforeEach(() => {
  h.config = { kind: "web" };
  h.api.attachmentLinks.mockReset();
  h.api.attachmentLinks.mockImplementation(async (ids: string[]) =>
    ids.map((id) => ({ id, url: `/media/${id}?t=tok`, expiresAt: "2099-01-01T00:00:00Z" })),
  );
  // mockReset + a fresh implementation, not mockClear: a test below installs a
  // never-settling one, which would otherwise leak into every later test.
  h.api.reply.mockReset();
  h.api.reply.mockImplementation(async () => ({ messageId: "activity-msg", seq: 1, threadId: "thread-1" }));
  h.api.sendChannelMessage.mockReset();
  h.api.sendChannelMessage.mockImplementation(async () => ({ messageId: "activity-msg", seq: 1 }));
  saved = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ href: this.href, download: this.getAttribute("download") });
  });
  windowOpen = vi.spyOn(window, "open").mockReturnValue(null);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
  // jsdom has no layout: the thread scrolls itself on mount.
  Element.prototype.scrollTo = vi.fn();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each<[string, AttachmentScope]>([
  ["chat (DM conversation)", "conversation"],
  ["channel", "channel"],
])("3-dot → Download in a %s", (_label, scope) => {
  it.each([PPTX, DOCX, XLSX, ZIP, IMAGE, PDF, TEXT])(
    "downloads $name through ?dl=1 and records exactly one attachment_downloaded",
    async (item) => {
      renderThread(scope, [fileMessage([item])]);
      await openMenu();

      await userEvent.click(await screen.findByRole("menuitem", { name: "Download" }));

      // The explicit download: a scripted anchor with the filename and the server's flag.
      expect(saved).toEqual([{ href: `${urlOf(item.id)}&dl=1`, download: item.name }]);
      // Not an open: no tab, no in-app viewer.
      expect(windowOpen).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      // Exactly one DOWNLOADED, and no OPENED beside it.
      expect(posted(scope)).toEqual([["attachment_downloaded", item.id, `Me downloaded ${item.name}`]]);
    },
  );

  it("posts into the scope the file lives in, through that scope's own endpoint", async () => {
    renderThread(scope, [fileMessage([PDF])]);
    await openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: "Download" }));

    const own = scope === "conversation" ? h.api.reply : h.api.sendChannelMessage;
    const other = scope === "conversation" ? h.api.sendChannelMessage : h.api.reply;
    expect(own).toHaveBeenCalledTimes(1);
    expect(own.mock.calls[0]?.[0]).toBe("scope-1");
    expect(other).not.toHaveBeenCalled();
  });

  it("closes the menu once a download is chosen", async () => {
    renderThread(scope, [fileMessage([PDF])]);
    await openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: "Download" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("a message with several files offers one named Download each, and saves only the chosen one", async () => {
    renderThread(scope, [fileMessage([PPTX, ZIP])]);
    await openMenu();

    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Download Quarterly.pptx" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Download Assets.zip" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Download" })).not.toBeInTheDocument();

    await userEvent.click(within(menu).getByRole("menuitem", { name: "Download Assets.zip" }));

    expect(saved).toEqual([{ href: `${urlOf("att-zip")}&dl=1`, download: "Assets.zip" }]);
    expect(posted(scope)).toEqual([["attachment_downloaded", "att-zip", "Me downloaded Assets.zip"]]);
  });

  it("a plain text message has no Download entry", async () => {
    renderThread(scope, [{ id: "t1", senderId: "peer", body: "hello there", at: "2026-09-21T09:00:00Z" }]);
    await openMenu();

    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: /Download/ })).not.toBeInTheDocument();
  });

  it("downloads nothing and posts nothing when the server minted no link for this viewer", async () => {
    h.api.attachmentLinks.mockResolvedValue([]);
    renderThread(scope, [fileMessage([PPTX])]);
    await openMenu();

    await userEvent.click(await screen.findByRole("menuitem", { name: "Download" }));

    expect(saved).toEqual([]);
    expect(posted(scope)).toEqual([]);
  });

  it("does not double-post when Download is chosen twice before the first request settles", async () => {
    h.api.reply.mockImplementation(() => new Promise(() => {}));
    h.api.sendChannelMessage.mockImplementation(() => new Promise(() => {}));
    renderThread(scope, [fileMessage([PPTX])]);

    for (let i = 0; i < 2; i++) {
      await openMenu();
      await userEvent.click(await screen.findByRole("menuitem", { name: "Download" }));
    }

    expect(posted(scope)).toHaveLength(1);
  });

  it("two genuinely separate downloads of the same file post two DOWNLOADED activities", async () => {
    renderThread(scope, [fileMessage([PPTX])]);

    for (let i = 1; i <= 2; i++) {
      await openMenu();
      await userEvent.click(await screen.findByRole("menuitem", { name: "Download" }));
      await waitFor(() => expect(posted(scope)).toHaveLength(i));
      // Let the first request's settle handler clear its in-flight guard.
      await act(async () => {});
    }

    expect(posted(scope).map((p) => p[0])).toEqual(["attachment_downloaded", "attachment_downloaded"]);
    expect(saved).toHaveLength(2);
  });

  it("an open and a download of the same file are each recorded once, as their own kind", async () => {
    renderThread(scope, [fileMessage([PPTX])]);

    await userEvent.click(await screen.findByRole("button", { name: "Open Quarterly.pptx" }));
    await waitFor(() => expect(posted(scope)).toHaveLength(1));
    await act(async () => {});
    expect(saved).toEqual([]); // the normal click downloaded nothing

    await openMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: "Download" }));

    expect(posted(scope).map((p) => p[0])).toEqual(["attachment_opened", "attachment_downloaded"]);
    expect(saved).toHaveLength(1); // ...and only the menu did
  });
});
