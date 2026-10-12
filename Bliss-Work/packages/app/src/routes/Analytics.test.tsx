import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ChannelDTO, type ChannelAnalyticsDTO } from "@taskboard/shared";

const h = vi.hoisted(() => ({
  channels: vi.fn(),
  channelAnalytics: vi.fn(),
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h, config: {} }) }));

import { Analytics } from "./Analytics";

const CHANNEL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHANNEL = ChannelDTO.parse({
  id: CHANNEL_ID,
  name: "Design",
  memberCount: 1,
  lastMessage: null,
  lastMessageAt: null,
});
const ANALYTICS: ChannelAnalyticsDTO = {
  channelId: CHANNEL_ID,
  statusBreakdown: { sent: 1, acknowledged: 0, completed: 2, ignored: 0, left: 0, missed: 0 },
  completion: {
    totalAssignments: 3,
    completedAssignments: 2,
    assignmentCompletionRate: 66.7,
    totalUniqueTasks: 3,
    completedUniqueTasks: 2,
    abandonedUniqueTasks: 0,
    remainingUniqueTasks: 1,
    uniqueTaskCompletionRate: 66.7,
  },
  workload: [],
};

function mount(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/app/analytics" element={<Analytics />} />
          <Route path="/app/analytics/:channelId" element={<Analytics />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Analytics route", () => {
  it("renders the channel list", async () => {
    h.channels.mockResolvedValue([CHANNEL]);
    mount("/app/analytics");
    expect(await screen.findByRole("link", { name: /design/i })).toHaveAttribute(
      "href",
      `/app/analytics/${CHANNEL_ID}`,
    );
    expect(h.channelAnalytics).not.toHaveBeenCalled();
  });

  it("loads selected-channel analytics through the real panel", async () => {
    h.channels.mockResolvedValue([CHANNEL]);
    h.channelAnalytics.mockResolvedValue(ANALYTICS);
    mount(`/app/analytics/${CHANNEL_ID}`);

    expect((await screen.findByText("Total tasks")).parentElement).toHaveTextContent("3");
    expect(screen.getByText("Completed tasks").parentElement).toHaveTextContent("2");
    await waitFor(() => expect(h.channelAnalytics).toHaveBeenCalledWith(CHANNEL_ID));
  });

  it("shows the no-selection empty state without a channelId", async () => {
    h.channels.mockResolvedValue([CHANNEL]);
    mount("/app/analytics");

    expect(await screen.findByText("Select a channel")).toBeInTheDocument();
    expect(screen.getByText("Choose a channel on the left to view its analytics.")).toBeInTheDocument();
  });
});
