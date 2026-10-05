import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineEntry } from "@taskboard/shared";

const mocks = vi.hoisted(() => ({ activityTimeline: vi.fn() }));
vi.mock("../../lib/runtime", () => ({
  useRuntime: () => ({ api: { activityTimeline: mocks.activityTimeline } }),
}));

import { MemberTimeline } from "./MemberTimeline";

const screenshotEntry: TimelineEntry = {
  id: "activity-id",
  occurredAt: "2026-10-01T12:00:00.000Z",
  source: "desktop",
  category: "security",
  action: "screenshot.attempted",
  surface: "chats",
  targetKind: "conversation",
  targetId: "conversation-id",
  durationMs: null,
  detail: { context: "Chat: Ada" },
};

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemberTimeline userId="me" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.activityTimeline.mockReset().mockResolvedValue({ entries: [screenshotEntry], nextCursor: null });
});

describe("screenshot activity filters", () => {
  it("shows the event in Security and Everything", async () => {
    const user = userEvent.setup();
    mount();

    expect(await screen.findByText("Screenshot attempt blocked")).toBeInTheDocument();
    expect(screen.getByText("Chat: Ada")).toBeInTheDocument();
    await waitFor(() => expect(mocks.activityTimeline).toHaveBeenLastCalledWith(
      "me",
      expect.objectContaining({ category: undefined }),
    ));

    await user.click(screen.getByRole("tab", { name: "Security" }));
    expect(await screen.findByText("Screenshot attempt blocked")).toBeInTheDocument();
    expect(screen.getByText("Chat: Ada")).toBeInTheDocument();
    await waitFor(() => expect(mocks.activityTimeline).toHaveBeenLastCalledWith(
      "me",
      expect.objectContaining({ category: "security" }),
    ));

    await user.click(screen.getByRole("tab", { name: "Everything" }));
    expect(await screen.findByText("Screenshot attempt blocked")).toBeInTheDocument();
    expect(screen.getByText("Chat: Ada")).toBeInTheDocument();
    await waitFor(() => expect(mocks.activityTimeline).toHaveBeenLastCalledWith(
      "me",
      expect.objectContaining({ category: undefined }),
    ));
  });
});