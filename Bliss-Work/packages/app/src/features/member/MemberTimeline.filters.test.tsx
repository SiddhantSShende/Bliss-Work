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

const appFocus: TimelineEntry = {
  id: "a1",
  occurredAt: "2026-10-01T12:00:00.000Z",
  source: "desktop",
  category: "app",
  action: "app.focus",
  surface: null,
  targetKind: "app",
  targetId: "chrome.exe",
  durationMs: 60_000,
  detail: null,
};

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemberTimeline userId="me" />
    </QueryClientProvider>,
  );
}

const lastCategory = () => mocks.activityTimeline.mock.lastCall?.[1]?.category;

beforeEach(() => {
  mocks.activityTimeline.mockReset().mockResolvedValue({ entries: [appFocus], nextCursor: null });
});

describe("activity filters", () => {
  it("offers the filters in order, with Everything selected by default", async () => {
    mount();
    await screen.findByText("Used Google Chrome");

    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["Everything", "Work", "In-app", "Outside Activity", "Sign-ins", "Security"]);
    expect(screen.getByRole("tab", { name: "Everything" })).toHaveAttribute("aria-selected", "true");
    expect(lastCategory()).toBeUndefined();
  });

  it("asks the server for the outside view, rather than filtering rows itself", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("Used Google Chrome");

    await user.click(screen.getByRole("tab", { name: "Outside Activity" }));
    await waitFor(() => expect(lastCategory()).toBe("outside"));
    // The row on screen is whatever the server returned for that view.
    expect(await screen.findByText("Used Google Chrome")).toBeInTheDocument();
  });

  it.each([
    ["Work", "engagement"],
    ["In-app", "navigation"],
    ["Sign-ins", "auth"],
    ["Security", "security"],
  ])("still sends %s as the %s category", async (label, category) => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("Used Google Chrome");

    await user.click(screen.getByRole("tab", { name: label }));
    await waitFor(() => expect(lastCategory()).toBe(category));
  });

  it("shows the proper application name, not the executable", async () => {
    mount();
    expect(await screen.findByText("Used Google Chrome")).toBeInTheDocument();
    expect(screen.queryByText(/chrome\.exe/)).toBeNull();
  });
});
