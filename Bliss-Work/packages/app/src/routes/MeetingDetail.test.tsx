/**
 * The meeting detail pane: everything stored about one call, in the one place
 * that shows all of it.
 *
 * The two panels that matter most here are Chat and Notes, because until this
 * change there was nothing to show in them: both lived only on the SFU's data
 * channel and in each participant's own localStorage, so a meeting that was
 * over had no transcript at all and nobody who missed it could read a word.
 * These assert that the pane reads the SERVER's copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CallDTO } from "@taskboard/shared";

const api = {
  call: vi.fn(),
  callChat: vi.fn(),
  callNotes: vi.fn(),
  callRecording: vi.fn(),
  createCallInvite: vi.fn(),
};
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api, config: {} }) }));
vi.mock("../store/session", () => ({
  useSession: (sel: (s: unknown) => unknown) => sel({ user: { id: "u-me", orgId: "org-1" } }),
}));
vi.mock("../lib/userLabel", () => ({
  useUserLabels: () => ({
    nameOf: (id: string) =>
      ({ "u-me": "Me", "u-m": "Mayank", "u-s": "Siddhant", "u-a": "Ada" })[id] ?? id,
    avatarUrlOf: () => null,
  }),
}));
vi.mock("../lib/callWindow", () => ({ openCallTab: vi.fn() }));
vi.mock("../lib/MeetingSession", () => ({
  useMeetingSession: () => ({ enter: vi.fn(), restore: vi.fn(), call: null }),
}));

import { MeetingDetail } from "./MeetingDetail";

function person(userId: string, over: Record<string, unknown> = {}) {
  return {
    userId,
    orgId: "org-1",
    role: "PARTICIPANT" as const,
    username: userId,
    joinedAt: null,
    leftAt: null,
    waitingSince: null,
    external: false,
    ...over,
  };
}

function call(over: Partial<CallDTO> = {}): CallDTO {
  return {
    id: "c-1",
    orgId: "org-1",
    kind: "MEETING",
    title: "",
    media: "video",
    createdBy: "u-me",
    status: "ENDED",
    createdAt: "2026-08-01T09:00:00.000Z",
    startedAt: "2026-08-01T09:00:00.000Z",
    endedAt: "2026-08-01T10:15:00.000Z",
    participants: [],
    activeShares: [],
    ...over,
  } as CallDTO;
}

function renderDetail() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/app/meetings/c-1"]}>
        <Routes>
          <Route path="/app/meetings/:callId" element={<MeetingDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MeetingDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.callChat.mockResolvedValue({ items: [], nextCursor: null });
    api.callNotes.mockResolvedValue({ items: [], nextCursor: null });
  });
  afterEach(() => vi.restoreAllMocks());

  it("says how long the meeting ran, and when it started and ended", async () => {
    api.call.mockResolvedValue(call({ title: "Sprint review" }));
    renderDetail();
    expect(await screen.findByText("Sprint review")).toBeTruthy();
    expect(screen.getByText("1h 15m")).toBeTruthy();
    expect(screen.getByText("Duration")).toBeTruthy();
    expect(screen.getByText("End")).toBeTruthy();
  });

  it("shows the whole roster, and who actually turned up", async () => {
    api.call.mockResolvedValue(
      call({
        title: "Sprint review",
        participants: [
          person("u-m", { joinedAt: "2026-08-01T09:01:00.000Z", leftAt: "2026-08-01T10:15:00.000Z" }),
          person("u-s", { joinedAt: "2026-08-01T09:05:00.000Z" }),
          person("u-a"),
        ],
      }),
    );
    renderDetail();
    expect(await screen.findByText("People · 2 of 3 joined")).toBeTruthy();
    expect(screen.getByText("Mayank")).toBeTruthy();
    // Somebody who was invited and never came is said so, not omitted.
    expect(screen.getByText("Did not join")).toBeTruthy();
  });

  it("marks the host and anybody from another organisation", async () => {
    api.call.mockResolvedValue(
      call({
        title: "Sprint review",
        participants: [
          person("u-m", { role: "HOST", joinedAt: "2026-08-01T09:00:00.000Z" }),
          person("u-a", { external: true, joinedAt: "2026-08-01T09:00:00.000Z" }),
        ],
      }),
    );
    renderDetail();
    expect(await screen.findByText("Host")).toBeTruthy();
    expect(screen.getByText("External")).toBeTruthy();
  });

  it("names an untitled meeting after the people who were in it", async () => {
    api.call.mockResolvedValue(
      call({
        title: "",
        participants: [
          person("u-m", { joinedAt: "2026-08-01T09:00:00.000Z" }),
          person("u-s", { joinedAt: "2026-08-01T09:00:00.000Z" }),
          person("u-me", { joinedAt: "2026-08-01T09:00:00.000Z" }),
        ],
      }),
    );
    renderDetail();
    expect(await screen.findByText("Mayank & Siddhant")).toBeTruthy();
  });

  it("shows the meeting's KEPT chat — who said it, and when", async () => {
    api.call.mockResolvedValue(call({ title: "Sprint review" }));
    api.callChat.mockResolvedValue({
      items: [
        { id: "m1", callId: "c-1", senderId: "u-m", text: "Shall we ship it?", sentAt: "2026-08-01T09:10:00.000Z" },
        { id: "m2", callId: "c-1", senderId: "u-s", text: "Ship it.", sentAt: "2026-08-01T09:11:00.000Z" },
      ],
      nextCursor: null,
    });
    renderDetail();
    await screen.findByText("Sprint review");
    screen.getByRole("tab", { name: "Chat" }).click();
    expect(await screen.findByText("Shall we ship it?")).toBeTruthy();
    expect(screen.getByText("Ship it.")).toBeTruthy();
    expect(screen.getByText("Mayank")).toBeTruthy();
  });

  it("shows the meeting's KEPT notes, with their authors", async () => {
    api.call.mockResolvedValue(call({ title: "Sprint review" }));
    api.callNotes.mockResolvedValue({
      items: [
        { id: "n1", callId: "c-1", authorId: "u-a", text: "Decide the rollout date", writtenAt: "2026-08-01T09:20:00.000Z" },
      ],
      nextCursor: null,
    });
    renderDetail();
    await screen.findByText("Sprint review");
    screen.getByRole("tab", { name: "Notes" }).click();
    expect(await screen.findByText("Decide the rollout date")).toBeTruthy();
    expect(screen.getByText("Ada")).toBeTruthy();
  });

  it("says plainly that a meeting had no chat, rather than showing an empty box", async () => {
    api.call.mockResolvedValue(call({ title: "Sprint review" }));
    renderDetail();
    await screen.findByText("Sprint review");
    screen.getByRole("tab", { name: "Chat" }).click();
    expect(await screen.findByText("No chat in this meeting")).toBeTruthy();
  });

  it("offers Join on a live meeting and nothing to join on a finished one", async () => {
    api.call.mockResolvedValue(call({ title: "Standup", status: "LIVE", endedAt: null }));
    const { unmount } = renderDetail();
    expect(await screen.findByRole("button", { name: /Join/ })).toBeTruthy();
    unmount();

    api.call.mockResolvedValue(call({ title: "Retro", status: "ENDED" }));
    renderDetail();
    await screen.findByText("Retro");
    expect(screen.queryByRole("button", { name: /Join/ })).toBeNull();
  });

  it("reports a meeting it cannot load as a failure, never as an empty one", async () => {
    api.call.mockRejectedValue(new Error("403"));
    renderDetail();
    expect(await screen.findByText("Couldn't open this meeting.")).toBeTruthy();
  });
});
