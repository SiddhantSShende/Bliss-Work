/**
 * Opening a meeting that is over — from a stale list row, an old link, or a
 * lobby that outlived the meeting — says so, instead of asking for a token and
 * reporting "Unable to obtain meeting credentials".
 *
 * `useCallRoom` is mocked (its own 409 → "ended" mapping is covered in
 * useCallRoom.test.ts); this is about what CallRoom does with the answer, and
 * that a meeting that is still on keeps working exactly as before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CallDTO } from "@taskboard/shared";
import type { RoomStatus } from "../lib/useCallRoom";

const h = vi.hoisted(() => ({
  useCallRoomMock: vi.fn(),
  api: {
    createCallInvite: vi.fn(async () => ({ token: "tok" })),
    saveCallChat: vi.fn(async () => {}),
    saveCallNote: vi.fn(async () => {}),
    call: vi.fn(),
  },
}));
vi.mock("../lib/useCallRoom", () => ({
  useCallRoom: h.useCallRoomMock,
  isGetUserMediaDenied: () => false,
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));

import { CallRoom } from "./CallRoom";

HTMLMediaElement.prototype.play = () => Promise.resolve();
HTMLMediaElement.prototype.pause = () => {};

const LIVE: CallDTO = {
  id: "00000000-0000-4000-8000-000000000701",
  orgId: "00000000-0000-4000-8000-000000000999",
  kind: "CHANNEL",
  title: "Weekly sync",
  media: "video",
  createdBy: "00000000-0000-4000-8000-000000000001",
  scheduledAt: null,
  endsAt: null,
  startedAt: "2026-09-29T09:00:00.000Z",
  startedBy: null,
  endedAt: null,
  status: "LIVE",
  createdAt: "2026-09-29T09:00:00.000Z",
  participants: [],
  activeShares: [],
  channelIds: [],
} as CallDTO;

const ENDED: CallDTO = { ...LIVE, status: "ENDED", endedAt: "2026-09-29T10:00:00.000Z" };
// The inconsistent row: still LIVE, but it carries the time it ended.
const LIVE_BUT_ENDED_AT: CallDTO = { ...LIVE, endedAt: "2026-09-29T10:00:00.000Z" };

function room(over: Record<string, unknown> = {}) {
  return {
    join: vi.fn(async () => {}),
    leave: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    status: "idle" as RoomStatus,
    failStage: null,
    canStart: false,
    ended: false,
    participants: [],
    micOn: false,
    camOn: false,
    sharing: false,
    connectedAt: undefined,
    toggleMic: vi.fn(async () => {}),
    toggleCam: vi.fn(async () => {}),
    toggleShare: vi.fn(async () => {}),
    addPeople: vi.fn(async () => {}),
    sendData: vi.fn(),
    onData: vi.fn(() => () => {}),
    identity: "local",
    connected: false,
    waiting: false,
    ...over,
  };
}

function renderRoom(call: CallDTO, over: Record<string, unknown> = {}, autoJoin?: "video") {
  const hook = room(over);
  h.useCallRoomMock.mockReturnValue(hook);
  h.api.call.mockResolvedValue(call);
  const onClose = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CallRoom call={call} onClose={onClose} autoJoin={autoJoin} />
    </QueryClientProvider>,
  );
  return { hook, onClose };
}

beforeEach(() => {
  h.useCallRoomMock.mockReset();
  h.api.call.mockReset();
});

describe("CallRoom — a meeting that is over", () => {
  it.each([
    ["ENDED", ENDED],
    ["LIVE with an endedAt", LIVE_BUT_ENDED_AT],
  ])("shows 'This meeting has ended' and never requests a token (%s)", async (_name, call) => {
    const { hook, onClose } = renderRoom(call, {}, "video");

    expect(await screen.findByText("This meeting has ended")).toBeTruthy();
    expect(screen.queryByText("Unable to obtain meeting credentials")).toBeNull();
    expect(hook.join).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Leave" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not offer the pre-join lobby for it either", async () => {
    const { hook } = renderRoom(ENDED);

    expect(await screen.findByText("This meeting has ended")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Join meeting" })).toBeNull();
    expect(hook.join).not.toHaveBeenCalled();
  });

  it("explains a server 'call_ended' answer instead of a credentials failure, with no Retry", async () => {
    const { onClose } = renderRoom(LIVE, { status: "failed", failStage: "ended" }, "video");

    expect(await screen.findByText("This meeting has ended")).toBeTruthy();
    expect(screen.queryByText("Unable to obtain meeting credentials")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Leave" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("still reports a genuine token refusal as a credentials failure, with Retry", async () => {
    renderRoom(LIVE, { status: "failed", failStage: "token" }, "video");

    expect(await screen.findByText("Unable to obtain meeting credentials")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText("This meeting has ended")).toBeNull();
  });
});

describe("CallRoom — a meeting that is still on", () => {
  it("joins straight away when entered with autoJoin", async () => {
    const { hook } = renderRoom(LIVE, {}, "video");

    await waitFor(() => expect(hook.join).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("This meeting has ended")).toBeNull();
  });

  it("shows the pre-join lobby, not the ended state, and joins only on request", async () => {
    const { hook } = renderRoom(LIVE);

    const join = await screen.findByRole("button", { name: "Join meeting" });
    expect(screen.queryByText("This meeting has ended")).toBeNull();
    expect(hook.join).not.toHaveBeenCalled();

    await userEvent.click(join);
    await waitFor(() => expect(hook.join).toHaveBeenCalledTimes(1));
  });

  it("is not thrown out of a room it is already in when a refetch says it ended", async () => {
    // Connected users leave via the call-ended event, never because a refetch
    // landed; only an `idle` room is blocked.
    renderRoom(ENDED, { status: "connected", connected: true }, "video");

    await waitFor(() => expect(h.api.call).toHaveBeenCalled());
    expect(screen.queryByText("This meeting has ended")).toBeNull();
  });
});
