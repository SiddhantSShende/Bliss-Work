/**
 * A file opened or downloaded in a chat or channel is recorded WITH where it
 * happened: the chat or channel's name, kind and id, captured by the surface at
 * the moment of the action (never inferred later from the file name).
 *
 * Runs the real useChatMedia → useAttachmentActivity with the real MediaBubble;
 * only the runtime, session, toast and network are stubbed. The event is one
 * telemetry beacon event per act — telemetry-svc derives the Security record from
 * it (see its tests) — so "exactly one" here is what keeps the two in step.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AttachmentScope } from "@taskboard/shared";
import { encodeMedia, type MediaItem } from "../lib/chatEnvelope";

const h = vi.hoisted(() => ({
  api: {
    attachmentLinks: vi.fn(),
    mediaUrl: (path: string) => `https://msg.test${path}`,
    reply: vi.fn(async (..._a: unknown[]) => ({ messageId: "m", seq: 1, threadId: "t" })),
    sendChannelMessage: vi.fn(async (..._a: unknown[]) => ({ messageId: "m", seq: 1 })),
    sendBeacon: vi.fn(async (..._a: unknown[]) => ({ sessionId: "s1", accepted: 1 })),
  },
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: { kind: "web" } }) }));
vi.mock("../store/session", () => ({
  useSession: (sel: (s: { user: { id: string; username: string; displayName: string } }) => unknown) =>
    sel({ user: { id: "me", username: "me", displayName: "Me" } }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("../lib/fileTransfer", () => ({
  useFileTransfers: () => ({ stateOf: () => undefined, decline: vi.fn(), cancel: vi.fn() }),
}));

import { useChatMedia } from "./useChatMedia";

const IMAGE: MediaItem = { id: "att-img", name: "image.png", size: 2048, mime: "image/png" };
const PDF: MediaItem = { id: "att-pdf", name: "Report.pdf", size: 2048, mime: "application/pdf" };

function Surface({
  scope,
  scopeId,
  contextName,
  items,
}: {
  scope: AttachmentScope;
  scopeId: string;
  contextName?: string;
  items: MediaItem[];
}) {
  const media = useChatMedia({ scope, scopeId, meId: "me", contextName, send: vi.fn() });
  return (
    <>
      {media.renderBody({ id: "m1", senderId: "peer", body: encodeMedia(items) })}
      {media.overlay}
      {items.map((i) => (
        <button key={i.id} type="button" onClick={() => media.downloadItem(i)}>
          save {i.name}
        </button>
      ))}
    </>
  );
}

const renderSurface = (props: React.ComponentProps<typeof Surface>) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Surface {...props} />
    </QueryClientProvider>,
  );

type Beacon = { events: { action: string; category: string; surface: string; targetId: string; detail: Record<string, string> }[] };
const events = () => h.api.sendBeacon.mock.calls.flatMap((c) => (c[0] as Beacon).events);

beforeEach(() => {
  h.api.attachmentLinks.mockReset().mockImplementation(async (ids: string[]) =>
    ids.map((id) => ({ id, url: `/media/${id}?t=tok`, expiresAt: "2099-01-01T00:00:00Z" })),
  );
  h.api.sendBeacon.mockReset().mockImplementation(async () => ({ sessionId: "s1", accepted: 1 }));
  h.api.reply.mockClear();
  h.api.sendChannelMessage.mockClear();
  vi.spyOn(window, "open").mockReturnValue(null);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a file in a direct chat", () => {
  it("opening it records the chat's kind, id and name beside the file", async () => {
    renderSurface({ scope: "conversation", scopeId: "cv-9", contextName: "Divya Bhamri", items: [IMAGE] });
    await userEvent.click(await screen.findByRole("button", { name: "Open image.png" }));

    expect(events()).toEqual([
      expect.objectContaining({
        action: "attachment.opened",
        category: "engagement",
        surface: "chats",
        targetId: "att-img",
        detail: {
          filename: "image.png",
          conversation: "cv-9",
          contextKind: "direct",
          contextId: "cv-9",
          contextName: "Divya Bhamri",
        },
      }),
    ]);
  });

  it("downloading it records the same context", async () => {
    renderSurface({ scope: "conversation", scopeId: "cv-9", contextName: "Divya Bhamri", items: [PDF] });
    await screen.findByRole("button", { name: "Open Report.pdf" }); // links resolved
    await userEvent.click(screen.getByRole("button", { name: "save Report.pdf" }));

    expect(events()).toEqual([
      expect.objectContaining({
        action: "attachment.downloaded",
        detail: expect.objectContaining({ filename: "Report.pdf", contextKind: "direct", contextName: "Divya Bhamri" }),
      }),
    ]);
  });
});

describe("a file in a channel", () => {
  it("opening it records the channel's name — without the # (the timeline adds it)", async () => {
    renderSurface({ scope: "channel", scopeId: "ch-4", contextName: "GRC Development", items: [PDF] });
    await userEvent.click(await screen.findByRole("button", { name: "Open Report.pdf" }));

    expect(events()).toEqual([
      expect.objectContaining({
        action: "attachment.opened",
        surface: "channels",
        detail: {
          filename: "Report.pdf",
          channel: "ch-4",
          contextKind: "channel",
          contextId: "ch-4",
          contextName: "GRC Development",
        },
      }),
    ]);
  });

  it("downloading it records the channel too", async () => {
    renderSurface({ scope: "channel", scopeId: "ch-4", contextName: "GRC Development", items: [PDF] });
    await screen.findByRole("button", { name: "Open Report.pdf" });
    await userEvent.click(screen.getByRole("button", { name: "save Report.pdf" }));

    expect(events()).toEqual([
      expect.objectContaining({
        action: "attachment.downloaded",
        detail: expect.objectContaining({ contextKind: "channel", contextName: "GRC Development", channel: "ch-4" }),
      }),
    ]);
  });
});

describe("what is NOT recorded", () => {
  it("records no context — exactly the old row — when the surface has no name to give", async () => {
    renderSurface({ scope: "channel", scopeId: "ch-4", items: [PDF] });
    await userEvent.click(await screen.findByRole("button", { name: "Open Report.pdf" }));

    expect(events()).toHaveLength(1);
    expect(events()[0]!.detail).toEqual({ filename: "Report.pdf", channel: "ch-4" });
  });

  it("treats a blank name as no name", async () => {
    renderSurface({ scope: "conversation", scopeId: "cv-9", contextName: "   ", items: [IMAGE] });
    await userEvent.click(await screen.findByRole("button", { name: "Open image.png" }));
    expect(events()[0]!.detail).toEqual({ filename: "image.png", conversation: "cv-9" });
  });

  it("a download that never resolved a URL records nothing", async () => {
    h.api.attachmentLinks.mockResolvedValue([]);
    renderSurface({ scope: "channel", scopeId: "ch-4", contextName: "GRC Development", items: [PDF] });
    await userEvent.click(await screen.findByRole("button", { name: "save Report.pdf" }));

    expect(h.api.sendBeacon).not.toHaveBeenCalled();
  });

  it("nothing is recorded for a file that is only rendered", async () => {
    renderSurface({ scope: "channel", scopeId: "ch-4", contextName: "GRC Development", items: [PDF] });
    await screen.findByRole("button", { name: "Open Report.pdf" });
    expect(h.api.sendBeacon).not.toHaveBeenCalled();
  });

  it("a double click before the first report settles is one event, not two", async () => {
    h.api.sendBeacon.mockImplementation(() => new Promise(() => {}));
    renderSurface({ scope: "channel", scopeId: "ch-4", contextName: "GRC Development", items: [PDF] });
    const open = await screen.findByRole("button", { name: "Open Report.pdf" });
    await userEvent.click(open);
    await userEvent.click(open);
    expect(events()).toHaveLength(1);
  });

  it("sends no second, client-side security event — the server derives it", async () => {
    renderSurface({ scope: "conversation", scopeId: "cv-9", contextName: "Divya Bhamri", items: [IMAGE] });
    await userEvent.click(await screen.findByRole("button", { name: "Open image.png" }));
    expect(events().map((e) => e.category)).toEqual(["engagement"]);
    expect(events().some((e) => e.action.startsWith("file."))).toBe(false);
  });
});
