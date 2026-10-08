import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivitySummaryDTO, TimelineEntry } from "@taskboard/shared";

const mocks = vi.hoisted(() => ({ activitySummary: vi.fn(), activityTimeline: vi.fn() }));
vi.mock("../../lib/runtime", () => ({
  useRuntime: () => ({ api: mocks }),
}));

import { computeRange } from "../../lib/dateRange";
import { MemberAnalytics } from "./MemberAnalytics";

const hourly = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
hourly[0]![10] = 3_600_000; // Monday 10:00

function summary(over: Partial<ActivitySummaryDTO> = {}): ActivitySummaryDTO {
  return {
    userId: "u1", from: "2026-09-08", to: "2026-10-07",
    totalActiveMs: 16 * 3_600_000, totalIdleMs: 4 * 3_600_000, totalOnlineMs: 0,
    sessions: 217, events: 3702,
    days: [{ day: "2026-10-05", activeMs: 3_600_000, idleMs: 600_000, onlineMs: 0, sessions: 3, events: 40 }],
    bySurface: [], byAction: [], topApps: [], topSites: [], hourly,
    ...over,
  };
}

const focus: TimelineEntry = {
  id: "a1", occurredAt: "2026-10-06T11:34:00.000Z", source: "desktop", category: "app",
  action: "app.focus", surface: null, targetKind: "app", targetId: "chrome.exe",
  durationMs: 3_000, detail: null,
};

function mount(onViewAllActivity?: () => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemberAnalytics userId="me" onViewAllActivity={onViewAllActivity} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.activitySummary.mockReset().mockResolvedValue(summary());
  mocks.activityTimeline.mockReset().mockResolvedValue({ entries: [focus], nextCursor: null });
});

describe("Analytics tab", () => {
  it("renders the four summary cards and every section from the existing summary", async () => {
    mount();
    await screen.findByText("217");
    for (const label of ["Active Time", "Sessions", "Events", "Last Active"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText("3702")).toBeInTheDocument();
    for (const title of ["Activity Overview", "Top Applications", "Recent Activity", "When They Work", "Activity Trend"]) {
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    }
    expect(screen.getByText("Activity heatmap — darker means more activity")).toBeInTheDocument();
  });

  it("keeps the three range controls and re-queries the summary when one is chosen", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("217");
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Last 7 days", "Last 30 days", "Last 90 days"]);

    mocks.activitySummary.mockClear();
    await user.click(screen.getByRole("tab", { name: "Last 7 days" }));
    await waitFor(() => expect(mocks.activitySummary).toHaveBeenCalled());
    const [id, range] = mocks.activitySummary.mock.calls[0]!;
    expect(id).toBe("me");
    const spanDays = (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000;
    expect(spanDays).toBe(6);
  });

  it("shows a real comparison only when the previous period has data", async () => {
    mocks.activitySummary.mockImplementation(async (_u: string, r: { to: string }) =>
      // The previous window is the one that ends before the current one starts.
      r.to < computeRange("30d").to ? summary({ sessions: 210 }) : summary());
    mount();
    // 217 vs 210 sessions; active time and events are unchanged, so show no figure.
    expect(await screen.findByText("3%")).toBeInTheDocument();
    expect(screen.getByText("3%").parentElement).toHaveTextContent("vs previous period");
    expect(screen.getAllByText(/vs previous period/)).toHaveLength(1);
  });

  it("omits the comparison when there is nothing earlier to compare with", async () => {
    mocks.activitySummary.mockImplementation(async (_u: string, r: { to: string }) =>
      r.to < computeRange("30d").to ? summary({ totalActiveMs: 0, sessions: 0, events: 0 }) : summary());
    mount();
    await screen.findByText("217");
    expect(screen.queryByText(/vs previous period/)).toBeNull();
  });

  it("lists recent activity with the application's proper name and links to the Activity tab", async () => {
    const user = userEvent.setup();
    const onViewAll = vi.fn();
    mount(onViewAll);
    const card = (await screen.findByRole("heading", { name: "Recent Activity" })).closest("div.flex-col") as HTMLElement;
    expect(await within(card).findByText("Google Chrome")).toBeInTheDocument();
    expect(within(card).getByText("3s")).toBeInTheDocument();
    expect(mocks.activityTimeline).toHaveBeenCalledWith("me", { limit: 5 });

    await user.click(within(card).getByRole("button", { name: /View all activity/ }));
    expect(onViewAll).toHaveBeenCalledTimes(1);
  });

  it("says so, instead of inventing rows, when the summary carries no application data", async () => {
    mount();
    expect(await screen.findByText("No application data for this period.")).toBeInTheDocument();
  });

  it("draws the top applications when the summary provides them", async () => {
    mocks.activitySummary.mockResolvedValue(
      summary({ topApps: [{ key: "chrome.exe", label: "", valueMs: 4 * 3_600_000, count: 0 }] }),
    );
    mount();
    const card = (await screen.findByRole("heading", { name: "Top Applications" })).closest("div.flex-col") as HTMLElement;
    expect(await within(card).findByText("Google Chrome")).toBeInTheDocument();
    expect(within(card).getByText("4h")).toBeInTheDocument();
    expect(within(card).queryByText("No application data for this period.")).toBeNull();
  });

  it("shows the empty state, with the range controls still present, when there are no days", async () => {
    mocks.activitySummary.mockResolvedValue(summary({ days: [] }));
    mount();
    expect(await screen.findByText("No activity in this period")).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
  });
});
