/**
 * The 1:1 "Call" button, rewired onto the SAME path GroupCallDialog already
 * uses for the multi-person case: api.startDirectCall creates (and rings)
 * the call, then session.enter(call, undefined, media) takes the caller
 * straight into its room. System 1 (lib/useCall's own invite()/ring state
 * machine) is no longer involved at all — this is what replaces it for the
 * 1:1 case. Mounts the real DMView, following the same minimal mocking shape
 * as DMView.selfChat.test.tsx.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({
  conversation: {
    id: "cv-1",
    peerId: "peer-1",
    peerUsername: "sam",
    peerDisplayName: "Sam",
    blockedByMe: false,
    blockedByPeer: false,
  } as unknown,
  messages: [] as unknown[],
  startDirectCall: vi.fn(),
  sessionEnter: vi.fn(),
  sessionCall: null as unknown,
}));

const stub = (name: string) => {
  switch (name) {
    case "conversations": return async () => [h.conversation];
    case "messages": return async () => h.messages;
    case "startDirectCall": return h.startDirectCall;
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
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));
vi.mock("../lib/fileTransfer", () => ({
  useFileTransfers: () => ({ stateOf: () => undefined, decline: vi.fn(), cancel: vi.fn() }),
}));
vi.mock("../lib/MeetingSession", () => ({
  useMeetingSession: () => ({ call: h.sessionCall, enter: h.sessionEnter, minimized: false, exit: vi.fn() }),
}));
vi.mock("../lib/usePresence", () => ({ useUserStatus: () => () => "online" }));
vi.mock("../lib/selectedChat", () => ({
  useSelectedChat: () => ({ selectedId: "cv-1", closeChat: vi.fn(), openChat: vi.fn() }),
}));

import { DMView } from "./DMView";

function mount() {
  Element.prototype.scrollTo = vi.fn();
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/chats/cv-1"]}>
        <Routes>
          <Route path="/chats/:conversationId" element={<DMView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const CALL = { id: "call-1", kind: "DIRECT", media: "video", participants: [] };

beforeEach(() => {
  h.startDirectCall.mockReset().mockResolvedValue(CALL);
  h.sessionEnter.mockReset();
  h.sessionCall = null;
});

describe("DMView — 1:1 Call button", () => {
  it("creates the call via api.startDirectCall and enters the room with no pre-join", async () => {
    const user = userEvent.setup();
    mount();

    await user.click(await screen.findByTitle("Call"));
    await user.click(screen.getByText("Video Call"));

    await vi.waitFor(() => expect(h.sessionEnter).toHaveBeenCalled());
    expect(h.startDirectCall).toHaveBeenCalledExactlyOnceWith("peer-1", "video");
    // autoJoinMedia "video" is what makes CallRoom skip the pre-join lobby
    // for this entry point too — see MeetingSession.enter's own doc.
    expect(h.sessionEnter).toHaveBeenCalledExactlyOnceWith(CALL, undefined, "video");
  });

  it("voice call maps to the room's voice autoJoin, not video", async () => {
    const user = userEvent.setup();
    mount();

    await user.click(await screen.findByTitle("Call"));
    await user.click(screen.getByText("Voice Call"));

    await vi.waitFor(() => expect(h.sessionEnter).toHaveBeenCalled());
    expect(h.startDirectCall).toHaveBeenCalledExactlyOnceWith("peer-1", "audio");
    expect(h.sessionEnter).toHaveBeenCalledExactlyOnceWith(CALL, undefined, "voice");
  });

  it("will not start a second call while already in one", async () => {
    h.sessionCall = { id: "existing-call" };
    const user = userEvent.setup();
    mount();

    await user.click(await screen.findByTitle("Call"));
    await user.click(screen.getByText("Video Call"));

    expect(h.startDirectCall).not.toHaveBeenCalled();
    expect(h.sessionEnter).not.toHaveBeenCalled();
  });
});
