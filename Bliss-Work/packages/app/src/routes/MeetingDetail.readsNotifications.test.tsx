/**
 * Opening a meeting reads THAT meeting's notifications — the same rule the Tasks
 * section follows. Mounts the real MeetingDetail; the runtime is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { CallDTO } from "@taskboard/shared";
import { useSession } from "../store/session";
import { CHANNELS, ME, OCCURRENCE } from "../test/meetingFixtures";

const h = vi.hoisted(() => ({
  api: {
    call: vi.fn(),
    channels: vi.fn(),
    meetingSeries: vi.fn(),
    directory: vi.fn(),
    markNotificationsReadByTarget: vi.fn(),
    markNotificationRead: vi.fn(),
    markTaskNotificationsRead: vi.fn(),
    readAllNotifications: vi.fn(),
  },
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("../lib/MeetingSession", () => ({
  useMeetingSession: () => ({ enter: vi.fn(), restore: vi.fn(), call: null }),
}));
vi.mock("../lib/userLabel", () => ({
  useUserLabels: () => ({ nameOf: (id: string) => `user-${id.slice(-3)}`, avatarUrlOf: () => null }),
}));
vi.mock("../lib/callWindow", () => ({ openCallTab: () => false }));
vi.mock("../features/MeetingInviteLink", () => ({ MeetingInviteLink: () => null }));
vi.mock("../features/MeetingTranscript", () => ({
  MeetingChatPanel: () => null,
  MeetingNotesPanel: () => null,
}));

import { MeetingDetail } from "./MeetingDetail";

function renderDetail(callId: string, call: CallDTO | Error) {
  if (call instanceof Error) h.api.call.mockRejectedValue(call);
  else h.api.call.mockResolvedValue(call);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/app/meetings/${callId}`]}>
        <Routes>
          <Route path="/app/meetings/:callId" element={<MeetingDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useSession.setState({ user: ME });
  h.api.channels.mockReset().mockResolvedValue(CHANNELS);
  h.api.directory.mockReset().mockResolvedValue([]);
  h.api.meetingSeries.mockReset();
  for (const k of ["markNotificationsReadByTarget", "markNotificationRead", "markTaskNotificationsRead", "readAllNotifications"] as const) {
    h.api[k].mockReset().mockResolvedValue({ updated: 0 });
  }
});

describe("opening a meeting reads its notifications", () => {
  it("asks the server to read this meeting's notifications, and only this meeting's", async () => {
    renderDetail(OCCURRENCE.id, OCCURRENCE);
    await screen.findByRole("heading", { name: "Design sync" });

    await waitFor(() => expect(h.api.markNotificationsReadByTarget).toHaveBeenCalledTimes(1));
    expect(h.api.markNotificationsReadByTarget).toHaveBeenCalledWith({ callId: OCCURRENCE.id });
    expect(h.api.readAllNotifications).not.toHaveBeenCalled();
    expect(h.api.markTaskNotificationsRead).not.toHaveBeenCalled();
    expect(h.api.markNotificationRead).not.toHaveBeenCalled();
  });

  // The hook sits above the loading/error returns so hook order is stable; this
  // pins that a meeting that fails to load neither crashes nor changes the call.
  it("is unaffected by a meeting that fails to load", async () => {
    renderDetail(OCCURRENCE.id, new Error("gone"));
    await waitFor(() => expect(h.api.call).toHaveBeenCalled());
    await waitFor(() => expect(h.api.markNotificationsReadByTarget).toHaveBeenCalledTimes(1));
    expect(h.api.markNotificationsReadByTarget).toHaveBeenCalledWith({ callId: OCCURRENCE.id });
  });
});
