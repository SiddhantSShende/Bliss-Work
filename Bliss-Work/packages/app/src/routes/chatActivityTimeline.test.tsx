/**
 * Whether a file open/download notice ("Piyush opened Report.pdf") is DRAWN in a
 * chat timeline. It is only in a LOCKED channel — not in an open channel, not in a
 * 1:1 or group chat, even for notices already stored there — and a screenshot
 * notice, which has its own rule, is drawn everywhere exactly as before.
 *
 * Mounts the real ChannelView / DMView around the real ChatThread (so the notice is
 * the same SystemPill a screenshot notice uses); only the runtime is stubbed.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChannelDTO } from "@taskboard/shared";

const h = vi.hoisted(() => ({
  channel: { id: "ch-1", name: "ops", memberCount: 3, isLocked: true, createdBy: "boss" } as unknown as ChannelDTO,
  messages: [] as unknown[],
  conversation: { id: "cv-1", peerId: "peer", peerName: "Sam" } as unknown,
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
const api = new Proxy({}, { get: (_t, name: string) => stub(name) });

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

const msg = (id: string, kind: string, body: string, seq: number) => ({
  id, seq, kind, body, senderId: "peer", senderUsername: "piyush", senderDisplayName: "Piyush",
  channelId: "ch-1", conversationId: "cv-1", createdAt: "2026-10-01T09:00:00Z",
});
const OPENED = "Piyush opened Text Extraction CSV Data Report.pdf";
const DOWNLOADED = "Piyush downloaded Text Extraction CSV Data Report.pdf";
const SHOT = "Mayank tried to take a screenshot";

const NOTICES = [
  msg("m1", "attachment_opened", OPENED, 1),
  msg("m2", "attachment_downloaded", DOWNLOADED, 2),
  msg("m3", "screenshot_attempt", SHOT, 3),
];

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

const pillOf = (text: string) => screen.getByText(text).closest("span.rounded-full");

describe("file activity in the chat timeline", () => {
  it("LOCKED channel: both notices are drawn as compact system pills, beside the screenshot one", async () => {
    h.channel = { ...h.channel, isLocked: true };
    h.messages = NOTICES;
    mount(<ChannelView />, "/channels/ch-1", "/channels/:channelId");

    for (const text of [OPENED, DOWNLOADED, SHOT]) {
      await screen.findByText(text);
      const pill = pillOf(text);
      expect(pill, `${text} is a SystemPill`).not.toBeNull();
      expect(pill!.parentElement!.className).toContain("justify-center");
    }
  });

  it("OPEN channel: neither notice is drawn — the screenshot notice still is", async () => {
    h.channel = { ...h.channel, isLocked: false };
    h.messages = NOTICES;
    mount(<ChannelView />, "/channels/ch-1", "/channels/:channelId");

    await screen.findByText(SHOT);
    expect(screen.queryByText(OPENED)).not.toBeInTheDocument();
    expect(screen.queryByText(DOWNLOADED)).not.toBeInTheDocument();
  });

  it("1:1 / group chat: neither notice is drawn — the screenshot notice still is", async () => {
    h.messages = NOTICES;
    mount(<DMView />, "/chats/cv-1", "/chats/:conversationId");

    await screen.findByText(SHOT);
    expect(screen.queryByText(OPENED)).not.toBeInTheDocument();
    expect(screen.queryByText(DOWNLOADED)).not.toBeInTheDocument();
  });
});
