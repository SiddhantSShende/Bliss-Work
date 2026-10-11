/**
 * The real ChannelView and DMView hand their chat's name to file activity, so a
 * file opened there is recorded with where it happened (lib/useAttachmentActivity).
 * The hook's own behaviour is covered in features/fileActivityContext.test.tsx;
 * this is the wiring — that each surface passes the name it is showing the user.
 *
 * Same harness as chatActivityTimeline.test.tsx: the real views around the real
 * ChatThread, with only the runtime stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChannelDTO } from "@taskboard/shared";

const h = vi.hoisted(() => ({
  channel: { id: "ch-1", name: "ops", memberCount: 3, isLocked: true, createdBy: "boss" } as unknown as ChannelDTO,
  messages: [] as unknown[],
  conversation: { id: "cv-1", peerId: "peer", peerName: "Sam" } as unknown,
  beacon: vi.fn(async (..._a: unknown[]) => ({ sessionId: "s", accepted: 1 })),
  links: vi.fn(async (ids: string[]) => ids.map((id) => ({ id, url: `/media/${id}?t=tok`, expiresAt: "2099-01-01T00:00:00Z" }))),
}));

const stub = (name: string) => {
  switch (name) {
    case "channels": return async () => [h.channel];
    case "channelMessages": return async () => h.messages;
    case "conversations": return async () => [h.conversation];
    case "messages": return async () => h.messages;
    default: return async () => [];
  }
};
const api = new Proxy({}, { get: (_t, name: string) => (name === "sendBeacon" ? h.beacon : name === "attachmentLinks" ? h.links : stub(name)) });

const rtc = new Proxy({}, { get: (_t, name: string) => (name.startsWith("on") ? () => () => {} : vi.fn()) });
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, rtc, config: { kind: "web" } }) }));
vi.mock("../store/session", () => {
  const user = { id: "me", username: "me", displayName: "Me", roles: [] as string[] };
  const state = { user, status: "authed" };
  const useSession = (sel: (s: typeof state) => unknown) => sel(state);
  useSession.getState = () => state;
  return { useSession };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("../lib/fileTransfer", () => ({
  useFileTransfers: () => ({ stateOf: () => undefined, decline: vi.fn(), cancel: vi.fn() }),
}));

// The shell state ChannelView/DMView read from context, as the app shell provides it.
vi.mock("../lib/MeetingSession", () => ({
  useMeetingSession: () => ({ enter: vi.fn(), session: null, active: false }),
}));
vi.mock("../lib/useCall", () => ({
  useCall: () => new Proxy({}, { get: () => vi.fn() }),
}));
vi.mock("../lib/selectedChat", () => ({
  useSelectedChat: () => ({ selectedId: "cv-1", closeChat: vi.fn(), openChat: vi.fn() }),
}));

import { ChannelView } from "./ChannelView";
import { DMView } from "./DMView";

import { encodeMedia } from "../lib/chatEnvelope";

const FILE = { id: "att-pdf", name: "Text Extraction CSV Data Report.pdf", size: 2048, mime: "application/pdf" };
const fileMessage = {
  id: "m1", seq: 1, kind: "text", body: encodeMedia([FILE]), senderId: "peer", senderUsername: "piyush",
  senderDisplayName: "Piyush", channelId: "ch-1", conversationId: "cv-1", createdAt: "2026-10-01T09:00:00Z",
};

type Beacon = { events: { action: string; detail: Record<string, string> }[] };
const events = () => h.beacon.mock.calls.flatMap((c) => (c[0] as Beacon).events);

function mount(ui: React.ReactNode, path: string, route: string) {
  Element.prototype.scrollTo = vi.fn();
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={route} element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.beacon.mockClear();
  h.messages = [fileMessage];
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
});

describe("the real views hand the chat/channel name to file activity", () => {
  it("ChannelView: opening a file records the channel's own name", async () => {
    h.channel = { ...h.channel, name: "GRC Development", isLocked: false };
    mount(<ChannelView />, "/channels/ch-1", "/channels/:channelId");

    await userEvent.click(await screen.findByRole("button", { name: `Open ${FILE.name}` }));

    expect(events()).toEqual([
      expect.objectContaining({
        action: "attachment.opened",
        detail: expect.objectContaining({
          filename: FILE.name,
          contextKind: "channel",
          contextId: "ch-1",
          contextName: "GRC Development",
        }),
      }),
    ]);
  });

  it("DMView: opening a file records the peer's display name, as the chat itself shows it", async () => {
    h.conversation = { id: "cv-1", peerId: "peer", peerUsername: "d.bhamri", peerDisplayName: "Divya Bhamri" };
    mount(<DMView />, "/chats/cv-1", "/chats/:conversationId");

    await userEvent.click(await screen.findByRole("button", { name: `Open ${FILE.name}` }));

    expect(events()).toEqual([
      expect.objectContaining({
        action: "attachment.opened",
        detail: expect.objectContaining({
          contextKind: "direct",
          contextId: "cv-1",
          contextName: "Divya Bhamri",
          conversation: "cv-1",
        }),
      }),
    ]);
  });
});
