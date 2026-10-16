/**
 * Icons and hover-only durations in the activity timeline. The row's shape,
 * timestamp, message, and platform label are unchanged — this only adds an
 * icon before the message and makes the duration badge hover/focus-only.
 */
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineEntry } from "@taskboard/shared";

const mocks = vi.hoisted(() => ({ activityTimeline: vi.fn() }));
vi.mock("../../lib/runtime", () => ({
  useRuntime: () => ({ api: { activityTimeline: mocks.activityTimeline } }),
}));

import { MemberTimeline } from "./MemberTimeline";

let n = 0;
const row = (action: string, over: Partial<TimelineEntry> = {}): TimelineEntry => ({
  id: `row-${++n}`,
  occurredAt: "2026-10-01T12:00:00.000Z",
  source: "web",
  category: "engagement",
  action,
  surface: null,
  targetKind: null,
  targetId: null,
  durationMs: null,
  detail: null,
  ...over,
});

const TASK_COMPLETED = row("task.completed");
const OPENED_TASKS = row("route.enter", { surface: "tasks" });
const APP_FOCUS_VSCODE = row("app.focus", { targetId: "C:\\apps\\Code.exe", durationMs: 125_000 });

function renderTimeline() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemberTimeline userId="me" />
    </QueryClientProvider>,
  );
}

const li = (text: string) => screen.getByText(text).closest("li")!;

beforeEach(() => {
  mocks.activityTimeline.mockReset().mockResolvedValue({ entries: [], nextCursor: null });
});

describe("activity icons", () => {
  it("renders an icon before every message, including a brand icon for a known app", async () => {
    mocks.activityTimeline.mockResolvedValue({
      entries: [TASK_COMPLETED, OPENED_TASKS, APP_FOCUS_VSCODE],
      nextCursor: null,
    });
    renderTimeline();
    await screen.findByText("Completed a task");

    for (const text of ["Completed a task", "Opened Tasks", "Used Visual Studio Code"]) {
      const icon = within(li(text)).getByText(text).parentElement!.querySelector('[aria-hidden="true"] svg');
      expect(icon).toBeTruthy();
    }
  });

  it("does not change the message, timestamp, or platform label", async () => {
    mocks.activityTimeline.mockResolvedValue({ entries: [TASK_COMPLETED], nextCursor: null });
    renderTimeline();
    await screen.findByText("Completed a task");
    expect(screen.getByText("Web app")).toBeInTheDocument();
  });
});

describe("hover-only duration", () => {
  beforeEach(() => {
    mocks.activityTimeline.mockResolvedValue({ entries: [APP_FOCUS_VSCODE], nextCursor: null });
  });

  it("keeps the duration present but visually hidden until hover or focus", async () => {
    renderTimeline();
    await screen.findByText("Used Visual Studio Code");

    const badge = screen.getByText("2m");
    const wrapper = badge.closest('[tabindex="0"]')!;
    expect(wrapper).toBeTruthy();
    expect(wrapper.className).toContain("opacity-0");
    expect(wrapper.className).toContain("group-hover:opacity-100");
    expect(wrapper.className).toContain("group-focus-within:opacity-100");
  });

  it("is reachable by keyboard focus", async () => {
    renderTimeline();
    await screen.findByText("Used Visual Studio Code");

    const wrapper = screen.getByText("2m").closest('[tabindex="0"]')!;
    (wrapper as HTMLElement).focus();
    expect(document.activeElement).toBe(wrapper);
  });
});
