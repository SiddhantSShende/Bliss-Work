import { act, fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallDTO, ChannelDTO, UserDTO } from "@taskboard/shared";
import { qk } from "../lib/queryKeys";
import { useActiveThread } from "../lib/activeThread";
import { useSession } from "../store/session";

type ScreenshotInfo = { chord: string; recorded: boolean; route?: string };
type ScreenshotListener = (info: ScreenshotInfo) => void;

const mocks = vi.hoisted(() => ({
  api: {
    sendBeacon: vi.fn(),
    sendMessage: vi.fn(),
    sendChannelMessage: vi.fn(),
  },
  config: {
    kind: "electron" as "electron" | "web",
    onScreenshotBlocked: undefined as ((cb: ScreenshotListener) => () => void) | undefined,
  },
  toastError: vi.fn(),
}));

vi.mock("../lib/runtime", () => ({
  useRuntime: () => ({ api: mocks.api, config: mocks.config }),
}));
vi.mock("../lib/telemetrySession", () => ({ getSessionId: () => "session-id" }));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));

import { ScreenshotNotice } from "./ScreenshotNotice";

let screenshotListener: ScreenshotListener | undefined;

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ScreenshotNotice />
    </QueryClientProvider>,
  );
  return client;
}

function emit(route?: string) {
  if (!screenshotListener) throw new Error("Desktop screenshot listener was not registered");
  act(() => screenshotListener!({ chord: "PrintScreen", recorded: false, route }));
}

function activityEvent() {
  return mocks.api.sendBeacon.mock.calls[0]?.[0].events[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.kind = "electron";
  mocks.config.onScreenshotBlocked = (callback) => {
    screenshotListener = callback;
    return () => {
      screenshotListener = undefined;
    };
  };
  screenshotListener = undefined;
  useSession.setState({
    status: "authed",
    user: { id: "user-id", username: "member", displayName: "Member" } as UserDTO,
  });
  useActiveThread.setState({ thread: null });
  mocks.api.sendBeacon.mockResolvedValue({ sessionId: "session-id", accepted: 1 });
  mocks.api.sendMessage.mockResolvedValue({ messageId: "message-id", seq: 1 });
  mocks.api.sendChannelMessage.mockResolvedValue({ messageId: "channel-message-id", seq: 1 });
});

describe("Desktop screenshot activity", () => {
  it("records a Chat context and preserves the existing Chat warning", () => {
    useActiveThread.getState().setActiveThread({
      kind: "chat",
      conversationId: "conversation-id",
      peerId: "peer-id",
      peerName: "Ada",
    });
    mount();

    emit("/app/chats");

    expect(mocks.api.sendBeacon).toHaveBeenCalledTimes(1);
    expect(activityEvent()).toMatchObject({
      action: "screenshot.attempted",
      category: "security",
      surface: "chats",
      targetKind: "conversation",
      targetId: "conversation-id",
      detail: {
        chord: "PrintScreen",
        context: "Chat: Ada",
        contextName: "Ada",
        contextId: "conversation-id",
        route: "/app/chats",
      },
    });
    expect(mocks.api.sendBeacon.mock.calls[0]?.[0]).toMatchObject({ source: "desktop" });
    expect(activityEvent().clientEventId).toEqual(expect.any(String));
    expect(Date.parse(activityEvent().occurredAt)).not.toBeNaN();
    expect(mocks.api.sendMessage).toHaveBeenCalledWith("peer-id", "Member tried to take a screenshot", undefined, "screenshot_attempt");
  });

  it("records a named Channel context and preserves the existing Channel warning", () => {
    const client = mount();
    client.setQueryData(qk.channels, [{ id: "channel-id", name: "Design", memberCount: 2 } as ChannelDTO]);
    useActiveThread.getState().setActiveThread({ kind: "channel", channelId: "channel-id" });

    emit("/app/channels/channel-id");

    expect(activityEvent()).toMatchObject({
      category: "security",
      surface: "channels",
      targetKind: "channel",
      targetId: "channel-id",
      detail: { context: "Channel: #Design", contextName: "Design", contextId: "channel-id" },
    });
    expect(mocks.api.sendChannelMessage).toHaveBeenCalledWith(
      "channel-id",
      "Member tried to take a screenshot",
      undefined,
      "screenshot_attempt",
    );
  });

  it("records other page and meeting contexts without posting a chat warning", () => {
    const client = mount();
    emit("/app/tasks/allocated");
    expect(activityEvent()).toMatchObject({ surface: "tasks", detail: { context: "Tasks" } });
    expect(mocks.api.sendMessage).not.toHaveBeenCalled();
    expect(mocks.api.sendChannelMessage).not.toHaveBeenCalled();

    mocks.api.sendBeacon.mockClear();
    client.setQueryData(qk.call("call-id"), { title: "Design review" } as CallDTO);
    emit("/call/call-id");
    expect(activityEvent()).toMatchObject({
      surface: "meetings",
      targetKind: "meeting",
      targetId: "call-id",
      detail: { context: "Meeting: Design review", contextName: "Design review" },
    });

    mocks.api.sendBeacon.mockClear();
    emit("/app/meetings/call-id");
    expect(activityEvent()).toMatchObject({
      surface: "meetings",
      targetKind: "meeting",
      targetId: "call-id",
      detail: { context: "Meeting: Design review" },
    });
  });

  it("uses the Desktop fallback when the originating route is unavailable", () => {
    mount();
    emit();

    expect(mocks.api.sendBeacon).toHaveBeenCalledTimes(1);
    expect(activityEvent()).toMatchObject({ detail: { context: "BlissWork Desktop" } });
    expect(activityEvent().surface).toBeUndefined();
  });

  it("does not create activity rows from web screenshot key handling", () => {
    mocks.config.kind = "web";
    mocks.config.onScreenshotBlocked = undefined;
    mount();

    fireEvent.keyDown(window, { key: "PrintScreen" });

    expect(mocks.api.sendBeacon).not.toHaveBeenCalled();
  });
});